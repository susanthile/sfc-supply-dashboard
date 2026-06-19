// generate.js — Fetch Lightfield supply data and rebuild index.html
// Run: LIGHTFIELD_API_KEY=<key> node generate.js

const fs = require('fs');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE = 'https://api.lightfield.app';
const API_KEY  = process.env.LIGHTFIELD_API_KEY;
if (!API_KEY) { console.error('Missing LIGHTFIELD_API_KEY'); process.exit(1); }

// Supply-side deal type option IDs
const PROVIDERS_ID    = 'opt_5e9751fe-bb0e-4ec1-ae36-631257fa257a'; // 3rd-party clusters
const DATA_CENTERS_ID = 'opt_23d2a171-e583-4d76-9b70-b456043b6402'; // SFC-owned

const GPU_LABEL = {
  'opt_aec52a86-1ae9-4f38-86ae-e5097d6ad417': 'H100',
  'opt_185fddd5-b00b-4331-ac74-7894b4b47f88': 'H200',
  'opt_15f26dc5-4cc0-40e6-ba7e-3690a7da9a41': 'B200',
  'opt_9b76383c-b60a-44ef-be59-dbe2e480554f': 'B300',
  'opt_82d983e8-443a-4292-a68d-1850069c2da0': 'GB300',
};

const STAGE_LABEL = {
  'opt_010d0100-d27b-4100-828b-d382a44e3e5c': 'Revisit',
  'opt_62d3f3db-1ea8-4c9c-a59b-14d4c5d9fef9': 'Lead',
  'opt_7f0eca42-846d-47ee-9690-2d9f7de4f691': 'Qualification',
  'opt_a5a0037c-13f0-4857-9337-7d72fd2ab9a2': 'Post-Qual',
  'opt_0e1c2ebf-a83b-4f89-aded-aba53784e8b3': 'Contracting',
  'opt_b13c9790-565e-43c0-b08e-10c41a10b225': 'For Signature',
  'opt_45c5dea8-9918-4a1d-9557-fde3ef94c12a': 'Won',
  'opt_acbe1211-bd79-46bc-930e-609a58a0f21c': 'Lost',
  'opt_ff465465-5f88-4c7a-afe3-e71dc1c42e35': 'Closed Revisit',
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
function get(path) {
  return new Promise((resolve, reject) => {
    const url = API_BASE + path;
    const options = {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Lightfield-Version': '2026-03-01',
        'Content-Type': 'application/json',
      },
    };
    https.get(url, options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}: ${body}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ── Location extraction from opportunity name ─────────────────────────────────
// Pulls city/state hint from patterns like "CraneDC — Hillsboro, OR"
// or "Colo 6MW Columbus OH" or "10MW Texas"
const STATE_ABBRS = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

function extractLocation(name) {
  // Pattern 1: "— City, ST" or "– City, ST"
  const dashMatch = name.match(/[—–]\s*(.+)$/);
  if (dashMatch) {
    const candidate = dashMatch[1].trim();
    // Accept if it contains a comma (City, State) or a known state abbr
    if (candidate.includes(',') || STATE_ABBRS.has(candidate.split(/\s+/).pop())) {
      return candidate;
    }
  }

  // Pattern 2: "City, ST" anywhere in name (last occurrence)
  const cityStateMatch = name.match(/([A-Z][a-z][\w\s]+,\s*[A-Z]{2})(?:[^,]|$)/g);
  if (cityStateMatch) return cityStateMatch[cityStateMatch.length - 1].replace(/[^,\w\s]/g,'').trim();

  // Pattern 3: a known country name at end
  const countries = ['Singapore','Finland','Malaysia','Sweden','Germany','Japan','UK','Australia'];
  for (const c of countries) {
    if (name.includes(c)) return c;
  }

  // Pattern 4: US state name at end of name
  const stateNames = ['Texas','California','Ohio','Alabama','Montana','Oregon','Virginia',
    'Georgia','Nevada','New York','Washington','Colorado','Florida','Indiana',
    'South Carolina','North Carolina','Tennessee','Oklahoma'];
  for (const s of stateNames) {
    if (name.includes(s)) return s;
  }

  return '';
}

// ── Map one Lightfield opportunity → cluster row ──────────────────────────────
function mapOpp(opp, idx) {
  const f = opp.fields;

  const types     = f['type']?.value ?? [];
  const isThirdParty  = types.includes(PROVIDERS_ID);
  const source    = isThirdParty ? '3rd Party' : 'SFC';

  const gpuOpts   = f['gpu-type-91264f6']?.value ?? [];
  const gpuType   = gpuOpts.length ? GPU_LABEL[gpuOpts[0]] ?? null : null;

  const capacity  = f['gpu-count']?.value ?? null;

  const stageOpt  = f['$stage']?.value;
  const stage     = stageOpt ? (STAGE_LABEL[stageOpt] ?? stageOpt) : 'Unknown';

  const closeDateRaw = f['$closeDate']?.value;
  const eta       = closeDateRaw ? closeDateRaw.slice(0, 10) : null; // "YYYY-MM-DD"

  const name      = f['$name']?.value ?? '(unnamed)';
  const location  = extractLocation(name);
  const link      = opp.httpLink ?? '';

  return {
    id: idx + 1,
    name,
    source,
    location,
    stage,
    eta,
    gpuType,
    capacity,
    opStatus: 'Offline',
    utilization: 0,
    notes: '',
    link,
  };
}

// ── Fetch all supply-side opportunities ───────────────────────────────────────
async function fetchAllSupply() {
  const all = [];
  const LIMIT = 5;
  let offset = 0;

  console.log('Fetching Lightfield opportunities...');
  while (true) {
    const page = await get(`/v1/opportunities?limit=${LIMIT}&offset=${offset}`);
    const records = page.data ?? [];
    all.push(...records);
    console.log(`  Fetched ${all.length} / ${page.totalCount ?? '?'}`);
    if (records.length < LIMIT) break;
    offset += LIMIT;
  }

  console.log(`Total fetched: ${all.length}. Filtering for supply-side...`);
  const supply = all.filter(opp => {
    const types = opp.fields?.['type']?.value ?? [];
    return types.includes(PROVIDERS_ID) || types.includes(DATA_CENTERS_ID);
  });
  console.log(`Supply-side opportunities: ${supply.length}`);
  return supply;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const supply = await fetchAllSupply();

  // Sort: 3rd Party first, then SFC
  supply.sort((a, b) => {
    const aTypes = a.fields?.['type']?.value ?? [];
    const bTypes = b.fields?.['type']?.value ?? [];
    const aIs3P = aTypes.includes(PROVIDERS_ID);
    const bIs3P = bTypes.includes(PROVIDERS_ID);
    if (aIs3P && !bIs3P) return -1;
    if (!aIs3P && bIs3P) return 1;
    return 0;
  });

  const clusters = supply.map(mapOpp);

  // Build the JS data lines
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const clustersJS = [
    `// ── Live data from Lightfield CRM — ${today} ─────────────────────────────`,
    `let clusters = [`,
    ...clusters.map((c, i) => {
      const last = i === clusters.length - 1;
      return `  ${JSON.stringify(c)}${last ? '' : ','}`;
    }),
    `];`,
  ].join('\n');

  // Inject into template
  const template = fs.readFileSync('template.html', 'utf8');
  const output   = template.replace('// @@CLUSTERS_DATA@@', clustersJS);

  fs.writeFileSync('index.html', output, 'utf8');
  console.log(`✓ index.html written (${clusters.length} clusters, ${output.length} bytes)`);
}

main().catch(err => { console.error(err); process.exit(1); });
