const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

const BASE = "https://www.andersoncircuitcourt.com";
const SEARCH_URL = `${BASE}/Search/search.aspx?search=criminal`;
const CASE_URL = (id) =>
  `${BASE}/Search/CriminalCase.aspx?CaseID=${id}&court=SUPERIOR&county=ANDERSON%20CIRCUIT%20AND%20SESSIONS`;
const OFFENSES_URL = (id) =>
  `${BASE}/Search/CriminalOffenses.aspx?CaseID=${id}&court=SUPERIOR&county=ANDERSON%20CIRCUIT%20AND%20SESSIONS`;

// Parse case year from case number
// Digit-prefix: "26ST0174" → 2026
// Letter-prefix: "C4C00319" → C=202x, 4=2024
function parseCaseYear(caseNum) {
  if (!caseNum) return null;
  const first = caseNum.charAt(0);
  if (/\d/.test(first)) {
    const yy = parseInt(caseNum.substring(0, 2), 10);
    return 2000 + yy;
  }
  // Letter prefix: second char is the year digit
  const letterMap = { A: 2010, B: 2011, C: 2020 }; // C = 202x decade
  const decade = letterMap[first.toUpperCase()];
  if (decade !== undefined) {
    const digit = parseInt(caseNum.charAt(1), 10);
    if (!isNaN(digit)) return decade + digit;
  }
  return null;
}

let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }
  return browser;
}

// Search for a person and return matching case IDs
async function searchPerson(page, firstName, lastName) {
  // Step 1: Visit the Search landing page (loads Main.aspx in an iframe)
  await page.goto(`${BASE}/Search/`, { waitUntil: "networkidle2", timeout: 30000 });

  // Step 2: Wait for the iframe to load Main.aspx
  await page.waitForFunction(() => {
    const frames = document.querySelectorAll('iframe');
    return frames.length > 0;
  }, { timeout: 10000 });

  // Step 3: Get the iframe frame context
  const frames = page.frames();
  let searchFrame = frames.find(f => f.url().includes("Main.aspx"));
  if (!searchFrame) {
    // Fallback: navigate directly to Main.aspx
    await page.goto(`${BASE}/Search/Main.aspx`, { waitUntil: "networkidle2", timeout: 30000 });
    searchFrame = page.mainFrame();
  }

  // Step 4: Click "Criminal" link inside Main.aspx to get to criminal search
  const criminalLink = await searchFrame.$('a[href*="criminal"]') || await searchFrame.$('a[href*="Criminal"]');
  if (criminalLink) {
    await criminalLink.click();
    await new Promise(r => setTimeout(r, 3000)); // Wait for navigation within iframe
  }

  // Step 5: Re-find the frame (URL may have changed)
  const updatedFrames = page.frames();
  searchFrame = updatedFrames.find(f => f.url().includes("search.aspx")) || searchFrame;

  // Wait for the search input to appear (in the frame)
  await searchFrame.waitForSelector("#ctl00_ContentPlaceHolder1_tbPersonSearch", { timeout: 15000 });

  // Fill the person search box (in the frame)
  await searchFrame.type("#ctl00_ContentPlaceHolder1_tbPersonSearch", `${lastName}, ${firstName}`);

  // Submit via __EVENTTARGET pattern
  await searchFrame.evaluate(() => {
    __doPostBack("ctl00$ContentPlaceHolder1$btnSearch", "");
  });
  // Wait for results to load
  await new Promise(r => setTimeout(r, 5000));

  // Parse search results — look for case links
  const cases = await searchFrame.evaluate(() => {
    const results = [];
    // Results are typically in a grid/table with links to CriminalCase.aspx
    const links = document.querySelectorAll('a[href*="CriminalCase.aspx"]');
    links.forEach((link) => {
      const href = link.getAttribute("href");
      const caseIdMatch = href.match(/CaseID=(\d+)/i);
      if (caseIdMatch) {
        // Get the row text for context
        const row = link.closest("tr");
        const text = row ? row.innerText.trim() : link.innerText.trim();
        results.push({
          caseId: caseIdMatch[1],
          text,
          caseNumber: link.innerText.trim(),
        });
      }
    });
    return results;
  });

  return cases;
}

// Fetch case detail page (unauthenticated — limited fields)
async function fetchCaseDetail(page, caseId) {
  await page.goto(CASE_URL(caseId), { waitUntil: "networkidle2", timeout: 30000 });

  const detail = await page.evaluate(() => {
    const val = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      if (el.tagName === "SELECT") {
        const selected = el.querySelector("option[selected]") || el.querySelector("option");
        return selected ? selected.textContent.trim() : null;
      }
      return el.value || el.textContent.trim() || null;
    };

    // Extract judge and bond from link text
    let judge = null;
    let bond = null;
    const allLinks = document.querySelectorAll("a");
    allLinks.forEach((a) => {
      const t = a.textContent.trim();
      if (t.startsWith("Judge:")) judge = t.replace("Judge:", "").trim();
      if (t.includes("BOND $")) {
        const m = t.match(/BOND\s*\$\s*([\d,.]+)/);
        if (m) bond = m[1].replace(/,/g, "");
      }
    });

    return {
      caseNumber: val("ctl00_ContentPlaceHolder1_tbCaseNumber"),
      caseStatus: val("ctl00_ContentPlaceHolder1_tbCaseStatus"),
      filingDate: val("ctl00_ContentPlaceHolder1_tbFilingDate"),
      firstName: val("ctl00_ContentPlaceHolder1_tbFirstName"),
      lastName: val("ctl00_ContentPlaceHolder1_tbLastName"),
      middleName: val("ctl00_ContentPlaceHolder1_tbMiddleName"),
      caseType: val("ctl00_ContentPlaceHolder1_ddTypeOfCase"),
      dob: val("ctl00_ContentPlaceHolder1_tbBirth"),
      address: val("ctl00_ContentPlaceHolder1_tbAddress"),
      city: val("ctl00_ContentPlaceHolder1_tbCity"),
      state: val("ctl00_ContentPlaceHolder1_ddStates"),
      zip: val("ctl00_ContentPlaceHolder1_tbZip"),
      phone: val("ctl00_ContentPlaceHolder1_tbPhoneNumber"),
      race: val("ctl00_ContentPlaceHolder1_ddRace"),
      sex: val("ctl00_ContentPlaceHolder1_ddSex"),
      judge,
      bond,
    };
  });

  return detail;
}

// Fetch offenses for a case
async function fetchOffenses(page, caseId) {
  await page.goto(OFFENSES_URL(caseId), { waitUntil: "networkidle2", timeout: 30000 });

  const offenses = await page.evaluate(() => {
    const rows = [];
    // Offense table rows
    const trs = document.querySelectorAll("table tr");
    trs.forEach((tr) => {
      const tds = tr.querySelectorAll("td");
      if (tds.length >= 4) {
        rows.push({
          count: tds[0]?.textContent.trim(),
          statute: tds[1]?.textContent.trim(),
          description: tds[2]?.textContent.trim(),
          level: tds[3]?.textContent.trim(),
        });
      }
    });
    return rows;
  });

  return offenses;
}

// Main enrichment endpoint
app.get("/enrich", async (req, res) => {
  const { firstName, lastName } = req.query;
  if (!firstName || !lastName) {
    return res.status(400).json({ error: "firstName and lastName required" });
  }

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Debug mode
    if (req.query.debug === "1") {
      await page.goto(`${BASE}/Search/`, { waitUntil: "networkidle2", timeout: 30000 });
      
      // List all frames
      const frameInfo = page.frames().map(f => ({ url: f.url(), name: f.name() }));
      
      // Get iframe content
      const iframeFrame = page.frames().find(f => f.url().includes("Main.aspx") || f.url().includes("main"));
      let iframeHtml = "no iframe found";
      let iframeLinks = [];
      if (iframeFrame) {
        iframeHtml = await iframeFrame.content();
        iframeLinks = await iframeFrame.evaluate(() =>
          Array.from(document.querySelectorAll('a')).map(a => ({href: a.href, text: a.textContent.trim()}))
        );
      }
      
      return res.json({
        mainUrl: page.url(),
        frames: frameInfo,
        iframeSnippet: (iframeHtml || '').substring(0, 3000),
        iframeLinks: iframeLinks.slice(0, 30),
      });
    }

    // Step 1: Search
    const cases = await searchPerson(page, firstName, lastName);
    if (!cases.length) {
      return res.json({ found: false, firstName, lastName, cases: [] });
    }

    // Step 2: Filter to recent cases (current year or last year)
    const currentYear = new Date().getFullYear();
    const recentCases = cases.filter((c) => {
      const yr = parseCaseYear(c.caseNumber);
      return yr && yr >= currentYear - 1;
    });

    const targetCases = recentCases.length > 0 ? recentCases : cases.slice(0, 3);

    // Step 3: Fetch details + offenses for each case
    const enriched = [];
    for (const c of targetCases.slice(0, 5)) {
      const detail = await fetchCaseDetail(page, c.caseId);
      const offenses = await fetchOffenses(page, c.caseId);
      enriched.push({ ...detail, offenses, _searchText: c.text });
    }

    return res.json({ found: true, firstName, lastName, cases: enriched });
  } catch (err) {
    console.error("Enrichment error:", err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Court enrichment service running on port ${PORT}`);
});
