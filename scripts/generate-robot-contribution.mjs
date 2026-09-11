import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const username = process.env.GITHUB_USERNAME || process.argv[2] || "fuad13579";
const outputPath = resolve(process.env.OUTPUT_PATH || "assets/robot-contribution.svg");
const streakOutputPath = resolve(process.env.STREAK_OUTPUT_PATH || "assets/streak-telemetry.svg");
const statsOutputPath = resolve(process.env.STATS_OUTPUT_PATH || "assets/github-stats.svg");
const languagesOutputPath = resolve(process.env.LANGUAGES_OUTPUT_PATH || "assets/top-languages.svg");
const token = process.env.GITHUB_TOKEN;

const LEVELS = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"];

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { "User-Agent": "robot-contribution-card", ...options.headers },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function loadFromGraphql() {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount contributionLevel}}}}}}`;
  const response = await fetchWithRetry("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login: username } }),
  });
  const payload = await response.json();
  if (payload.errors?.length || !payload.data?.user) {
    throw new Error(payload.errors?.[0]?.message || `GitHub user '${username}' was not found`);
  }
  const calendar = payload.data.user.contributionsCollection.contributionCalendar;
  return { weeks: calendar.weeks, total: calendar.totalContributions, source: "GitHub GraphQL API" };
}

async function loadFromPublicProfile() {
  const response = await fetchWithRetry(`https://github.com/users/${encodeURIComponent(username)}/contributions`);
  const html = await response.text();
  const counts = new Map([...html.matchAll(/<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)]
    .map((match) => {
      const count = match[2].match(/([\d,]+) contributions?/i);
      return [match[1], count ? Number(count[1].replaceAll(",", "")) : 0];
    }));
  const days = [...html.matchAll(/<(?:td|rect)\b[^>]*\bdata-date="([^"]+)"[^>]*\bid="([^"]+)"[^>]*\bdata-level="([0-4])"[^>]*>/g)]
    .map((match) => ({ date: match[1], contributionCount: counts.get(match[2]) ?? null, contributionLevel: LEVELS[Number(match[3])] }));
  if (!days.length) throw new Error("GitHub returned no public contribution cells");

  const first = new Date(`${days[0].date}T00:00:00Z`);
  const weeks = [];
  for (const day of days) {
    const date = new Date(`${day.date}T00:00:00Z`);
    const weekIndex = Math.floor((date - first) / 604800000);
    (weeks[weekIndex] ||= { contributionDays: [] }).contributionDays.push(day);
  }
  const knownCounts = days.filter((day) => day.contributionCount != null);
  const total = knownCounts.length === days.length
    ? knownCounts.reduce((sum, day) => sum + day.contributionCount, 0)
    : null;
  return { weeks, total, source: "GitHub public contribution calendar" };
}

async function loadProfile() {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchWithRetry(`https://api.github.com/users/${encodeURIComponent(username)}`, { headers });
  const profile = await response.json();
  return {
    publicRepos: profile.public_repos,
    followers: profile.followers,
    following: profile.following,
    createdAt: profile.created_at,
  };
}

async function loadRepositoryStats() {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchWithRetry(`https://api.github.com/users/${encodeURIComponent(username)}/repos?type=owner&sort=updated&per_page=100`, { headers });
  const repositories = await response.json();
  if (!Array.isArray(repositories)) throw new Error("GitHub returned invalid repository data");
  const owned = repositories.filter((repository) => !repository.fork);
  const languageMaps = await Promise.all(owned.map(async (repository) => {
    const languageResponse = await fetchWithRetry(repository.languages_url, { headers });
    return languageResponse.json();
  }));
  const languages = {};
  for (const map of languageMaps) {
    for (const [language, bytes] of Object.entries(map)) languages[language] = (languages[language] || 0) + bytes;
  }
  return {
    stars: owned.reduce((sum, repository) => sum + repository.stargazers_count, 0),
    forks: owned.reduce((sum, repository) => sum + repository.forks_count, 0),
    languages,
  };
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]);
}

function renderSvg(data) {
  const weeks = data.weeks.slice(-53);
  const cells = [];
  for (let week = 0; week < weeks.length; week += 1) {
    for (const day of weeks[week].contributionDays) {
      const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const level = Math.max(0, LEVELS.indexOf(day.contributionLevel));
      const label = day.contributionCount == null
        ? `activity level ${level} of 4`
        : day.contributionCount === 1 ? "1 contribution" : `${day.contributionCount} contributions`;
      cells.push(`<rect class="day l${level}" x="${38 + week * 13}" y="${65 + weekday * 13}" width="10" height="10" rx="2"><title>${escapeXml(day.date)}: ${escapeXml(label)}</title></rect>`);
    }
  }

  const totalLabel = data.total == null ? "Public contribution activity" : `${data.total.toLocaleString("en-US")} contributions in the last year`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="760" height="176" viewBox="0 0 760 176" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(username)}'s robot contribution activity</title>
  <desc id="desc">A minimalist robot scans ${escapeXml(username)}'s real GitHub contribution calendar. ${escapeXml(totalLabel)}.</desc>
  <style>
    :root { --bg:#ffffff; --border:#d0d7de; --text:#57606a; --empty:#ebedf0; --l1:#9be9a8; --l2:#40c463; --l3:#30a14e; --l4:#216e39; --robot:#57606a; --face:#f6f8fa; --accent:#2da44e; }
    @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --border:#30363d; --text:#8b949e; --empty:#161b22; --l1:#0e4429; --l2:#006d32; --l3:#26a641; --l4:#39d353; --robot:#8b949e; --face:#161b22; --accent:#3fb950; } }
    .card{fill:var(--bg);stroke:var(--border)} .label{fill:var(--text);font:600 12px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.04em}
    .day{fill:var(--empty)} .l1{fill:var(--l1)} .l2{fill:var(--l2)} .l3{fill:var(--l3)} .l4{fill:var(--l4)}
    .robot-line{stroke:var(--robot);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round} .robot-fill{fill:var(--face);stroke:var(--robot);stroke-width:1.6} .robot-accent{fill:var(--accent)}
  </style>
  <rect class="card" x=".5" y=".5" width="759" height="175" rx="10"/>
  <text class="label" x="38" y="27">CONTRIBUTION SIGNAL</text>
  <text class="label" x="722" y="27" text-anchor="end">${escapeXml(totalLabel.toUpperCase())}</text>
  <g aria-label="Contribution calendar">${cells.join("")}</g>
  <path d="M38 157.5H722" stroke="var(--border)" stroke-width="1"/>
  <g class="moving">
    <animateTransform attributeName="transform" type="translate" values="31 0;681 0;31 0" keyTimes="0;.5;1" dur="18s" repeatCount="indefinite" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"/>
    <g>
      <animateTransform attributeName="transform" type="translate" values="0 0;0 -1.5;0 0" dur="1.2s" repeatCount="indefinite"/>
      <path class="robot-line" fill="none" d="M11 47v-5m0 0-3-3m3 3 3-3"/>
      <rect class="robot-fill" x="2" y="47" width="18" height="15" rx="4"/>
      <circle class="robot-accent" cx="8" cy="53" r="1.6"/>
      <circle class="robot-accent" cx="14" cy="53" r="1.6"><animate attributeName="opacity" values="1;1;.15;1" keyTimes="0;.78;.82;1" dur="4s" repeatCount="indefinite"/></circle>
      <path class="robot-line" fill="none" d="M5 63v3m12-3v3M2 55h-3m21 0h3"/>
      <path d="M5 62h12l5 24H0z" fill="var(--accent)" opacity=".08"><animate attributeName="opacity" values=".03;.13;.03" dur="2.4s" repeatCount="indefinite"/></path>
    </g>
  </g>
  <circle cx="38" cy="157.5" r="2" fill="var(--accent)"><animate attributeName="cx" values="38;722;38" keyTimes="0;.5;1" dur="18s" repeatCount="indefinite" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"/></circle>
</svg>`;
}

function analyzeStreaks(data) {
  const days = data.weeks
    .flatMap((week) => week.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-365);
  const isActive = (day) => day.contributionLevel !== "NONE";
  let longest = 0;
  let longestEnd = -1;
  let run = 0;
  let activeDays = 0;

  for (let index = 0; index < days.length; index += 1) {
    if (isActive(days[index])) {
      activeDays += 1;
      run += 1;
      if (run > longest) {
        longest = run;
        longestEnd = index;
      }
    } else {
      run = 0;
    }
  }

  let currentEnd = days.length - 1;
  if (currentEnd >= 0 && !isActive(days[currentEnd])) currentEnd -= 1;
  let current = 0;
  let currentStart = currentEnd;
  while (currentStart >= 0 && isActive(days[currentStart])) {
    current += 1;
    currentStart -= 1;
  }

  return {
    days,
    current,
    currentStart: current ? days[currentStart + 1].date : null,
    currentEnd: current ? days[currentEnd].date : null,
    longest,
    longestStart: longest ? days[longestEnd - longest + 1].date : null,
    longestEnd: longest ? days[longestEnd].date : null,
    activeDays,
  };
}

function formatRange(start, end) {
  if (!start || !end) return "NO ACTIVE RUN";
  const format = (date) => new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`)).toUpperCase();
  return `${format(start)} — ${format(end)}`;
}

function renderStreakSvg(data) {
  const stats = analyzeStreaks(data);
  const recent = stats.days.slice(-28);
  const recentCells = recent.map((day, index) => {
    const level = Math.max(0, LEVELS.indexOf(day.contributionLevel));
    return `<rect class="cell l${level}" x="${253 + index * 16}" y="145" width="11" height="11" rx="2"><title>${escapeXml(day.date)}: activity level ${level} of 4</title></rect>`;
  }).join("");
  const activePercent = stats.days.length ? Math.round((stats.activeDays / stats.days.length) * 100) : 0;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="760" height="184" viewBox="0 0 760 184" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(username)}'s streak telemetry</title>
  <desc id="desc">Current streak: ${stats.current} days. Longest streak in the displayed year: ${stats.longest} days. Active on ${stats.activeDays} days.</desc>
  <style>
    :root{--bg:#fff;--panel:#f6f8fa;--border:#d0d7de;--text:#24292f;--muted:#57606a;--empty:#ebedf0;--l1:#9be9a8;--l2:#40c463;--l3:#30a14e;--l4:#216e39;--accent:#2da44e}
    @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#c9d1d9;--muted:#8b949e;--empty:#21262d;--l1:#0e4429;--l2:#006d32;--l3:#26a641;--l4:#39d353;--accent:#3fb950}}
    .card{fill:var(--bg);stroke:var(--border)}.divider{stroke:var(--border)}.heading{fill:var(--muted);font:600 11px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.1em}.metric{fill:var(--text);font:700 26px ui-monospace,SFMono-Regular,Consolas,monospace}.detail{fill:var(--muted);font:500 10px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.04em}.cell{fill:var(--empty)}.l1{fill:var(--l1)}.l2{fill:var(--l2)}.l3{fill:var(--l3)}.l4{fill:var(--l4)}
  </style>
  <rect class="card" x=".5" y=".5" width="759" height="183" rx="10"/>
  <text class="heading" x="32" y="27">STREAK TELEMETRY</text>
  <text class="heading" x="728" y="27" text-anchor="end">ROLLING CONTRIBUTION CALENDAR</text>
  <path class="divider" d="M32 42H728M253 57v66M506 57v66M32 131H728"/>

  <g aria-label="Current streak">
    <circle cx="53" cy="75" r="5" fill="var(--accent)"><animate attributeName="opacity" values=".4;1;.4" dur="2.2s" repeatCount="indefinite"/></circle>
    <text class="heading" x="68" y="79">CURRENT STREAK</text>
    <text class="metric" x="32" y="110">${stats.current} DAYS</text>
    <text class="detail" x="138" y="108">${formatRange(stats.currentStart, stats.currentEnd)}</text>
  </g>
  <g aria-label="Longest streak in the last year">
    <text class="heading" x="277" y="79">LONGEST / 365D</text>
    <text class="metric" x="277" y="110">${stats.longest} DAYS</text>
    <text class="detail" x="383" y="108">${formatRange(stats.longestStart, stats.longestEnd)}</text>
  </g>
  <g aria-label="Active days in the last year">
    <text class="heading" x="530" y="79">ACTIVE DAYS</text>
    <text class="metric" x="530" y="110">${stats.activeDays}</text>
    <text class="detail" x="591" y="108">${activePercent}% OF ${stats.days.length} DAYS</text>
  </g>

  <text class="detail" x="32" y="153">RECENT 28 DAYS</text>
  <g aria-label="Recent contribution activity">${recentCells}</g>
  <circle cx="710" cy="150.5" r="3" fill="var(--accent)"><animate attributeName="r" values="2;4;2" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;.25;1" dur="2.4s" repeatCount="indefinite"/></circle>
</svg>`;
}

function renderStatsSvg(data) {
  const stats = analyzeStreaks(data);
  const contributions = stats.days.every((day) => day.contributionCount != null)
    ? stats.days.reduce((sum, day) => sum + day.contributionCount, 0)
    : null;
  const metrics = [
    ["STARS EARNED", data.repositories.stars],
    ["CONTRIBUTIONS / 365D", contributions ?? "—"],
    ["PUBLIC REPOSITORIES", data.profile.publicRepos],
    ["FOLLOWERS", data.profile.followers],
    ["ACTIVE DAYS / 365D", stats.activeDays],
    ["LONGEST STREAK / 365D", `${stats.longest}d`],
  ];
  const rows = metrics.map(([label, value], index) => {
    const y = 67 + index * 23;
    return `<g aria-label="${escapeXml(label)}: ${escapeXml(value)}"><circle class="dot" cx="27" cy="${y - 4}" r="3"/><text class="label" x="39" y="${y}">${escapeXml(label)}</text><text class="value" x="217" y="${y}" text-anchor="end">${escapeXml(Number.isFinite(value) ? value.toLocaleString("en-US") : value)}</text></g>`;
  }).join("");
  const starLabel = data.repositories.stars === 1 ? "1 star" : `${data.repositories.stars} stars`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="370" height="218" viewBox="0 0 370 218" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(username)}'s GitHub statistics</title>
  <desc id="desc">${starLabel}, ${contributions ?? "unknown"} contributions in the last 365 days, ${data.profile.publicRepos} public repositories, and ${data.profile.followers} followers.</desc>
  <style>
    :root{--bg:#fff;--panel:#f6f8fa;--border:#d0d7de;--text:#24292f;--muted:#57606a;--accent:#2da44e}
    @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#c9d1d9;--muted:#8b949e;--accent:#3fb950}}
    .card{fill:var(--bg);stroke:var(--border)}.heading{fill:var(--text);font:700 14px ui-monospace,SFMono-Regular,Consolas,monospace}.label{fill:var(--muted);font:600 9px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.035em}.value{fill:var(--text);font:700 11px ui-monospace,SFMono-Regular,Consolas,monospace}.dot{fill:var(--accent)}.ring{fill:none;stroke:var(--border);stroke-width:5}.signal{fill:none;stroke:var(--accent);stroke-width:5;stroke-linecap:round}
  </style>
  <rect class="card" x=".5" y=".5" width="369" height="217" rx="10"/>
  <text class="heading" x="22" y="31">${escapeXml(username.toUpperCase())} / GITHUB STATS</text>
  <path d="M22 42H348" stroke="var(--border)"/>
  ${rows}
  <g transform="translate(291 116)" aria-label="Animated repository signal">
    <circle class="ring" r="43"/><circle class="signal" r="43" stroke-dasharray="96 175"><animateTransform attributeName="transform" type="rotate" values="0;360" dur="12s" repeatCount="indefinite"/></circle>
    <circle r="25" fill="var(--panel)" stroke="var(--border)"/>
    <path d="M-9-10v19m0-12c15 0 18 7 18 17M-9 1c8 0 12-4 12-11" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>
    <circle cx="-9" cy="-11" r="4" fill="var(--accent)"/><circle cx="-9" cy="10" r="4" fill="var(--accent)"/><circle cx="3" cy="-11" r="4" fill="var(--accent)"/><circle cx="9" cy="15" r="4" fill="var(--accent)"/>
  </g>
  <text class="label" x="291" y="178" text-anchor="middle">PUBLIC ACTIVITY</text>
  <circle class="dot" cx="291" cy="193" r="2.5"><animate attributeName="opacity" values=".3;1;.3" dur="2s" repeatCount="indefinite"/></circle>
</svg>`;
}

function renderLanguagesSvg(data) {
  const entries = Object.entries(data.repositories.languages).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0) || 1;
  const palette = ["#3fb950", "#58a6ff", "#d2a8ff", "#f2cc60", "#ff7b72", "#79c0ff", "#a5d6ff", "#8b949e"];
  let offset = 0;
  const segments = entries.map(([, bytes], index) => {
    const width = (bytes / total) * 326;
    const segment = `<rect x="${(22 + offset).toFixed(2)}" y="55" width="${width.toFixed(2)}" height="9" fill="${palette[index]}"/>`;
    offset += width;
    return segment;
  }).join("");
  const legend = entries.map(([language, bytes], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 22 + column * 174;
    const y = 91 + row * 27;
    const percent = ((bytes / total) * 100).toFixed(1);
    return `<g aria-label="${escapeXml(language)}: ${percent}%"><circle cx="${x + 4}" cy="${y - 4}" r="4" fill="${palette[index]}"/><text class="language" x="${x + 15}" y="${y}">${escapeXml(language)}</text><text class="percent" x="${x + 158}" y="${y}" text-anchor="end">${percent}%</text></g>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="370" height="218" viewBox="0 0 370 218" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(username)}'s most used languages</title>
  <desc id="desc">Repository language usage calculated by bytes across owned public, non-fork repositories.</desc>
  <style>
    :root{--bg:#fff;--border:#d0d7de;--text:#24292f;--muted:#57606a}
    @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--border:#30363d;--text:#c9d1d9;--muted:#8b949e}}
    .card{fill:var(--bg);stroke:var(--border)}.heading{fill:var(--text);font:700 14px ui-monospace,SFMono-Regular,Consolas,monospace}.language{fill:var(--text);font:600 10px ui-monospace,SFMono-Regular,Consolas,monospace}.percent{fill:var(--muted);font:500 9px ui-monospace,SFMono-Regular,Consolas,monospace}.note{fill:var(--muted);font:500 8px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.04em}
  </style>
  <rect class="card" x=".5" y=".5" width="369" height="217" rx="10"/>
  <text class="heading" x="22" y="31">MOST USED LANGUAGES</text>
  <path d="M22 42H348" stroke="var(--border)"/>
  <clipPath id="bar"><rect x="22" y="55" width="326" height="9" rx="4.5"/></clipPath>
  <g clip-path="url(#bar)">${segments}</g>
  ${legend}
  <path d="M22 195H348" stroke="var(--border)"/>
  <text class="note" x="22" y="208">PUBLIC NON-FORK REPOSITORIES · CALCULATED BY CODE BYTES</text>
</svg>`;
}

let data;
try {
  data = token ? await loadFromGraphql() : await loadFromPublicProfile();
  data.profile = await loadProfile();
  data.repositories = await loadRepositoryStats();
} catch (error) {
  console.error(`Unable to load contribution data for ${username}: ${error.message}`);
  process.exit(1);
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderSvg(data), "utf8");
await mkdir(dirname(streakOutputPath), { recursive: true });
await writeFile(streakOutputPath, renderStreakSvg(data), "utf8");
await mkdir(dirname(statsOutputPath), { recursive: true });
await writeFile(statsOutputPath, renderStatsSvg(data), "utf8");
await mkdir(dirname(languagesOutputPath), { recursive: true });
await writeFile(languagesOutputPath, renderLanguagesSvg(data), "utf8");
console.log(`Generated activity, streak, stats, and language cards from ${data.source}.`);
