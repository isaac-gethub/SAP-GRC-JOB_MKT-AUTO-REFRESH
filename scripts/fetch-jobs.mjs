#!/usr/bin/env node
/**
 * Daily refresh for the standalone SAP GRC / Security / Controls Job Market app
 * (TIB Systems LLC — general public job-seeker tool).
 *
 * Pulls live postings from job boards that offer a free, public, key-based
 * API and writes them to jobs.json in the schema the brochure app expects.
 *
 * Boards WITHOUT a public API (Dice, LinkedIn, ZipRecruiter, Naukri, and any
 * market Adzuna doesn't cover — e.g. UAE) are intentionally NOT scraped here.
 * Those stay as the click-through "Search on <board>" buttons in the app.
 * Scraping them would violate each site's Terms of Service.
 *
 * Requires (as environment variables / GitHub Actions secrets):
 *   ADZUNA_APP_ID
 *   ADZUNA_APP_KEY
 * Free signup: https://developer.adzuna.com/
 *
 * If those are missing, the script logs a warning and exits WITHOUT writing
 * jobs.json, so a missing key never overwrites good existing data with an
 * empty file.
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "jobs.json");

// ---- corrected keyword taxonomy (see the job-search procedure document) ----
// Compound, SAP-anchored phrases only — no bare "GRC" / "Controls" / "Compliance".
const KEYWORDS = [
  "SAP Security GRC Consultant",
  "SAP GRC Access Control",
  "SAP GRC Process Control",
  "SAP Security & GRC",
  "SAP IAG Identity Access Governance",
  "SAP SOX ITGC",
  "SAP S4HANA Security",
];

// Adzuna country codes it actually supports. UAE is NOT in this list —
// that region stays click-through-only in the app.
const ADZUNA_REGIONS = [
  { country: "us", label: "United States", locationDisplay: null },
  { country: "gb", label: "United Kingdom", locationDisplay: null },
  { country: "in", label: "India (Hyderabad)", locationDisplay: "Hyderabad" },
];

const RESULTS_PER_KEYWORD = 4;
const MAX_PER_REGION = 8;

function formatPay(job) {
  if (!job.salary_min && !job.salary_max) return "";
  const fmt = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
  if (job.salary_min && job.salary_max && job.salary_min !== job.salary_max) {
    return `${fmt(job.salary_min)} – ${fmt(job.salary_max)}/yr`;
  }
  return `${fmt(job.salary_min || job.salary_max)}/yr`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function fetchAdzunaRegion({ country, label, locationDisplay }) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  const seen = new Map(); // dedupe by url

  for (const keyword of KEYWORDS) {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("results_per_page", String(RESULTS_PER_KEYWORD));
    url.searchParams.set("what", keyword);
    if (locationDisplay) url.searchParams.set("where", locationDisplay);
    url.searchParams.set("content-type", "application/json");

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[adzuna:${country}] "${keyword}" -> HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const job of data.results || []) {
        if (seen.has(job.redirect_url)) continue;
        seen.set(job.redirect_url, {
          title: job.title?.replace(/<[^>]+>/g, "").trim() || "Untitled role",
          company: job.company?.display_name || "Unknown company",
          location: job.location?.display_name || label,
          posted: formatDate(job.created),
          pay: formatPay(job),
          url: job.redirect_url,
          _created: job.created,
        });
      }
    } catch (err) {
      console.warn(`[adzuna:${country}] "${keyword}" -> ${err.message}`);
    }
  }

  return [...seen.values()]
    .sort((a, b) => new Date(b._created) - new Date(a._created))
    .slice(0, MAX_PER_REGION)
    .map(({ _created, ...rest }) => rest);
}

async function fetchRemoteOK() {
  try {
    const res = await fetch("https://remoteok.com/api", {
      headers: { "User-Agent": "TIB-Systems-Job-Market-Refresh/1.0" },
    });
    if (!res.ok) {
      console.warn(`[remoteok] HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const rows = Array.isArray(data) ? data.slice(1) : []; // first row is a legend object
    const relevant = rows.filter((j) => {
      const hay = `${j.position || ""} ${j.description || ""} ${(j.tags || []).join(" ")}`.toLowerCase();
      return hay.includes("sap") && (hay.includes("grc") || hay.includes("security") || hay.includes("controls") || hay.includes("audit"));
    });
    return relevant.slice(0, MAX_PER_REGION).map((j) => ({
      title: j.position || "Untitled role",
      company: j.company || "Unknown company",
      location: "Remote",
      posted: formatDate(j.date),
      pay: formatPay({ salary_min: j.salary_min, salary_max: j.salary_max }),
      url: j.url || `https://remoteok.com${j.slug ? "/remote-jobs/" + j.slug : ""}`,
    }));
  } catch (err) {
    console.warn(`[remoteok] ${err.message}`);
    return [];
  }
}

async function main() {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;

  if (!appId || !appKey) {
    console.warn(
      "ADZUNA_APP_ID / ADZUNA_APP_KEY not set — skipping refresh and leaving the existing jobs.json untouched.\n" +
      "Get a free key at https://developer.adzuna.com/ and add it as a GitHub Actions secret."
    );
    process.exit(0);
  }

  const regions = {};
  for (const region of ADZUNA_REGIONS) {
    console.log(`Fetching ${region.label}...`);
    regions[region.label] = await fetchAdzunaRegion(region);
  }

  console.log("Fetching Remote / Global (RemoteOK)...");
  const remote = await fetchRemoteOK();
  if (remote.length) regions["Remote / Global"] = remote;

  // Preserve UAE from the existing file, if present — Adzuna doesn't cover it,
  // so it isn't live-refreshed and shouldn't be wiped out by this script.
  try {
    const existingRaw = await readFile(OUTPUT_PATH, "utf-8");
    const existing = JSON.parse(existingRaw);
    if (existing.regions?.["United Arab Emirates"]) {
      regions["United Arab Emirates"] = existing.regions["United Arab Emirates"];
    }
  } catch {
    // no existing file yet — fine, just skip
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sources: ["Adzuna (US, UK, India)", "RemoteOK"],
    regions,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  const total = Object.values(regions).reduce((n, arr) => n + arr.length, 0);
  console.log(`Wrote ${OUTPUT_PATH} with ${total} listings across ${Object.keys(regions).length} regions.`);
}

main();
