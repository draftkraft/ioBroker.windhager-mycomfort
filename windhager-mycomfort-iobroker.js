/*
 * Windhager myComfort cloud client for CLI and ioBroker.
 *
 * Primary goal:
 *   connect to the Windhager cloud API and return heating objects with
 *   readable property names and current values.
 *
 * Auth:
 *   Prefer login:
 *     export WINDHAGER_EMAIL='<myComfort email>'
 *     export WINDHAGER_PASSWORD='<myComfort password>'
 *
 *   Or provide an existing token:
 *     export WINDHAGER_AUTH='<X-Comfort-Auth token captured from your iOS app>'
 *
 * CLI:
 *   node windhager-mycomfort-iobroker.js doctor --profile windhager-ios-profile.json
 *   node windhager-mycomfort-iobroker.js list --profile windhager-ios-profile.json
 *   node windhager-mycomfort-iobroker.js values --profile windhager-ios-profile.json
 *   node windhager-mycomfort-iobroker.js login --profile windhager-ios-profile.json
 *   node windhager-mycomfort-iobroker.js set-program --profile windhager-ios-profile.json --name "Fussboden West" --program "Program 1"
 */

'use strict';

const fs = require('fs');
const https = require('https');

const DEFAULT_PROFILE_PATH = process.env.WINDHAGER_PROFILE || './windhager-ios-profile.json';
const STATE_ROOT = '0_userdata.0.windhager.mycomfort';

const STATES = {
  online: `${STATE_ROOT}.info.online`,
  lastRefresh: `${STATE_ROOT}.info.lastRefresh`,
  lastError: `${STATE_ROOT}.info.lastError`,
  apiBaseUrl: `${STATE_ROOT}.info.apiBaseUrl`,
  authToken: `${STATE_ROOT}.auth.token`,
  authTokenExpiresAt: `${STATE_ROOT}.auth.tokenExpiresAt`,
  systemId: `${STATE_ROOT}.settings.systemId`,
  deviceIdentifier: `${STATE_ROOT}.settings.deviceIdentifier`,
  readConcurrency: `${STATE_ROOT}.settings.readConcurrency`,
  timeoutMs: `${STATE_ROOT}.settings.timeoutMs`,
  refreshIntervalSec: `${STATE_ROOT}.settings.refreshIntervalSec`
};

const LEGACY_STATES = [
  `${STATE_ROOT}.lastResult`,
  `${STATE_ROOT}.profileJson`,
  `${STATE_ROOT}.command.refreshValues`
];

const DEFAULT_PROFILE = {
  baseUrl: 'https://connect-api.windhager.com',
  timeoutMs: 15000,
  readConcurrency: 2,
  tokenRefreshSkewSeconds: 300,
  tokenCachePath: './windhager-token-cache.json',
  headers: {
    Accept: '*/*',
    'X-Device-Name': 'iPhone',
    'X-Comfort-Client': 'iOS/4.8.0',
    'Accept-Language': 'en',
    'X-Comfort-Auth': '{{authToken}}',
    'Content-Length': '0',
    'User-Agent': 'myComfort/231 CFNetwork/3860.500.112 Darwin/25.4.0',
    'X-Device-Identifier': '{{deviceIdentifier}}',
    'X-Device-Model': 'iPhone16,1'
  },
  systemId: '',
  deviceIdentifier: '',
  sessionPath: '/api/v1/sessions'
};

const PROGRAM_VALUES = {
  'Stand-by': '0',
  'Program 0': '0',
  'Program 1': '1',
  'Program 2': '2',
  'Program 3': '3',
  'Heating mode': '4',
  'Program 4': '4',
  'Setback mode': '5',
  'Program 5': '5',
  'DHW operation': '6',
  'Program 6': '6',
  'Manual mode': '7',
  'Program 7': '7',
  Cooling: '8'
};

const WRITABLE_OIDS = new Set([
  '1/1',
  '2/10',
  '3/50',
  '3/58'
]);

const ENUM_VALUES = {
  '3/50': {
    '0': 'Stand-by',
    '1': 'Program 1',
    '2': 'Program 2',
    '3': 'Program 3',
    '4': 'Heating mode',
    '5': 'Setback mode',
    '6': 'DHW operation',
    '7': 'Manual mode',
    '8': 'Cooling'
  },
  '2/9': {
    '0': 'Stand-by',
    '1': 'Heating mode',
    '2': 'Setback mode',
    '3': 'DHW charging',
    '4': 'Eco / Comfort',
    '5': 'Holiday program',
    '6': 'Screed',
    '7': 'Frost protection',
    '8': 'Stand-by',
    '9': 'Manual mode',
    '10': 'Test',
    '11': 'Chimney sweep',
    '12': 'Burner OFF',
    '13': 'Burner ON',
    '14': 'Automatic boiler',
    '15': 'Solid fuel boiler',
    '16': 'Accumulator tank',
    '17': 'Hot water hygiene programme',
    '18': 'DHW single charge',
    '19': 'Automatic operation',
    '20': 'Cooling',
    '21': 'Stand-by'
  }
};

const OID_NAMES = {
  '0/0': 'Outside temperature',
  '0/1': 'Room temperature Current value',
  '0/2': 'Flow temperature Current value',
  '0/4': 'DHW temperature Current value',
  '0/7': 'Boiler temp. current value',
  '0/9': 'Boiler output',
  '0/15': 'Temperature accumulator sensor top',
  '0/16': 'Temperature accumulator sensor bottom',
  '0/17': 'Temperature accumulator sensor centre',
  '1/1': 'Room temperature Setpoint heating',
  '1/2': 'Flow temperature Setpoint',
  '1/4': 'DHW temperature Setpoint',
  '1/7': 'Boiler temp. setpoint',
  '2/1': 'Operating phase',
  '2/9': 'Operating mode',
  '2/10': 'Temporary override duration',
  '2/80': 'Number of burner starts',
  '2/81': 'Operating hours',
  '3/50': 'Heating program',
  '3/58': 'Temperature correction',
  '20/112': 'Number of starts',
  '23/87': 'Charge status',
  '23/103': 'Fuel consumption total',
  '52/49': 'Number of starts heat',
  '52/80': 'Energy meter heat pump active power'
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function loadProfile(path = DEFAULT_PROFILE_PATH) {
  if (!fs.existsSync(path)) {
    throw new Error(`Missing profile: ${path}`);
  }
  return normalizeProfile(JSON.parse(fs.readFileSync(path, 'utf8')));
}

function normalizeProfile(profile) {
  return {
    ...DEFAULT_PROFILE,
    ...profile,
    headers: {
      ...DEFAULT_PROFILE.headers,
      ...(profile.headers || {})
    },
    authToken: process.env.WINDHAGER_AUTH || profile.authToken || '',
    email: process.env.WINDHAGER_EMAIL || profile.email || '',
    password: process.env.WINDHAGER_PASSWORD || profile.password || '',
    deviceIdentifier: process.env.WINDHAGER_DEVICE_IDENTIFIER || profile.deviceIdentifier || DEFAULT_PROFILE.deviceIdentifier
  };
}

function requireConfigured(profile, options = {}) {
  const requireAuth = options.auth !== false;
  const missing = [];
  if (!profile.baseUrl) missing.push('baseUrl');
  if (!profile.systemId) missing.push('systemId');
  if (requireAuth && !profile.authToken && !hasUsableCachedToken(profile) && !(profile.email && profile.password)) {
    missing.push('WINDHAGER_AUTH, cached token, or WINDHAGER_EMAIL/WINDHAGER_PASSWORD');
  }
  if (!profile.deviceIdentifier) missing.push('deviceIdentifier');
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}`);
  }
}

function render(value, context) {
  return String(value).replace(/\{\{(\w+)\}\}/g, (_match, key) => String(context[key] || ''));
}

async function request(profile, method, path, options = {}) {
  requireConfigured(profile, options);
  if (options.auth !== false) {
    profile.authToken = await getAuthToken(profile);
  }

  try {
    return await rawRequest(profile, method, path, options);
  } catch (error) {
    if (options.auth === false || options.retry === false || !isUnauthorized(error)) {
      throw error;
    }
    clearCachedToken(profile);
    profile.authToken = '';
    profile.authToken = await getAuthToken(profile, { forceLogin: true });
    return rawRequest(profile, method, path, { ...options, retry: false });
  }
}

function rawRequest(profile, method, path, options = {}) {
  const url = new URL(path, profile.baseUrl);
  const context = {
    authToken: profile.authToken,
    deviceIdentifier: profile.deviceIdentifier
  };
  const headers = Object.fromEntries(
    Object.entries(profile.headers || {}).map(([key, value]) => [key, render(value, context)])
  );
  if (options.auth === false) {
    delete headers['X-Comfort-Auth'];
  }
  let body = '';
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: Number(profile.timeoutMs || 15000)
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = parseJson(text);
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          const error = new Error(`${method} ${url.toString()} failed: ${res.statusCode} ${res.statusMessage} ${text}`.trim());
          error.statusCode = res.statusCode || 0;
          error.body = body;
          reject(error);
          return;
        }
        resolve(body);
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${profile.timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function isUnauthorized(error) {
  return error && error.statusCode === 401;
}

async function getAuthToken(profile, options = {}) {
  if (!options.forceLogin && isUsableToken(profile.authToken, profile)) {
    return profile.authToken;
  }

  if (!options.forceLogin) {
    const cached = readCachedToken(profile);
    if (isUsableToken(cached, profile)) {
      return cached;
    }
  }

  return login(profile);
}

async function login(profile) {
  if (!profile.email || !profile.password) {
    throw new Error('Login requires WINDHAGER_EMAIL and WINDHAGER_PASSWORD');
  }

  const body = await request(profile, 'POST', profile.sessionPath || DEFAULT_PROFILE.sessionPath, {
    auth: false,
    body: {
      email: profile.email,
      password: profile.password
    },
    retry: false
  });

  const token = extractToken(body);
  if (!token) {
    throw new Error(`Login succeeded but no auth token was found in response: ${JSON.stringify(body)}`);
  }

  writeCachedToken(profile, token);
  return token;
}

function extractToken(value) {
  if (!value) return null;
  if (typeof value === 'string') return looksLikeJwt(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = extractToken(item);
      if (token) return token;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      const token = extractToken(item);
      if (token) return token;
    }
  }
  return null;
}

function looksLikeJwt(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function tokenExpiryMs(token) {
  if (!looksLikeJwt(token)) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? Number(payload.exp) * 1000 : null;
  } catch (_error) {
    return null;
  }
}

function isUsableToken(token, profile) {
  if (!token) return false;
  const expiry = tokenExpiryMs(token);
  if (!expiry) return true;
  const skewMs = Number(profile.tokenRefreshSkewSeconds || 300) * 1000;
  return Date.now() + skewMs < expiry;
}

function hasUsableCachedToken(profile) {
  return isUsableToken(readCachedToken(profile), profile);
}

function readCachedToken(profile) {
  if (!profile.tokenCachePath) return '';
  try {
    const cache = JSON.parse(fs.readFileSync(profile.tokenCachePath, 'utf8'));
    return cache.authToken || '';
  } catch (_error) {
    return '';
  }
}

function writeCachedToken(profile, token) {
  if (!profile.tokenCachePath) return;
  const expiry = tokenExpiryMs(token);
  const cache = {
    authToken: token,
    expiresAt: expiry ? new Date(expiry).toISOString() : null
  };
  fs.writeFileSync(profile.tokenCachePath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

function clearCachedToken(profile) {
  if (!profile.tokenCachePath) return;
  try {
    fs.unlinkSync(profile.tokenCachePath);
  } catch (_error) {
    // Cache file is optional.
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function datapointsPath(profile) {
  return `/api/v1/systems/${encodeURIComponent(profile.systemId)}/datapoints`;
}

function datapointPath(profile, object, oid, value) {
  const params = new URLSearchParams({
    node_id: String(object.nodeId),
    oid,
    function_id: String(object.functionId)
  });
  if (value !== undefined) {
    params.set('value', String(value));
  }
  return `/api/v1/systems/${encodeURIComponent(profile.systemId)}/datapoint?${params.toString()}`;
}

async function getAvailableDatapoints(profile) {
  const body = await request(profile, 'GET', datapointsPath(profile));
  return Array.isArray(body?.datapoints) ? body.datapoints : [];
}

async function listObjects(profile) {
  const datapoints = await getAvailableDatapoints(profile);
  const objects = new Map();

  for (const point of datapoints) {
    const key = `${point.node_id}:${point.function_id}`;
    if (!objects.has(key)) {
      objects.set(key, {
        name: point.function_name,
        nodeName: point.node_name,
        nodeId: String(point.node_id),
        functionId: String(point.function_id),
        properties: []
      });
    }
    objects.get(key).properties.push({
      oid: point.oid,
      name: OID_NAMES[point.oid] || point.oid
    });
  }

  return Array.from(objects.values()).map((object) => ({
    ...object,
    properties: object.properties.sort((a, b) => a.oid.localeCompare(b.oid, undefined, { numeric: true }))
  }));
}

async function readPropertyValue(profile, object, property) {
  const body = await request(profile, 'GET', datapointPath(profile, object, property.oid));
  return {
    value: body?.value ?? null,
    unit: body?.unit || '',
    timestamp: body?.timestamp || null
  };
}

async function listValues(profile) {
  const objects = await listObjects(profile);
  const result = {};

  for (const object of objects) {
    const values = new Map();
    await mapLimit(object.properties, Number(profile.readConcurrency || 2), async (property) => {
      try {
        const data = await readPropertyValue(profile, object, property);
        values.set(property.name, formatValue(data, property.oid));
      } catch (error) {
        values.set(property.name, `ERROR: ${error.message}`);
      }
    });
    result[object.name] = Object.fromEntries(object.properties.map((property) => [property.name, values.get(property.name)]));
  }

  return result;
}

async function listRawValues(profile) {
  const objects = await listObjects(profile);
  const result = [];

  for (const object of objects) {
    const properties = [];
    await mapLimit(object.properties, Number(profile.readConcurrency || 2), async (property) => {
      try {
        properties.push({
          ...property,
          ...(await readPropertyValue(profile, object, property))
        });
      } catch (error) {
        properties.push({
          ...property,
          value: null,
          unit: '',
          timestamp: null,
          error: error.message
        });
      }
    });
    result.push({
      ...object,
      properties: properties.sort((a, b) => a.oid.localeCompare(b.oid, undefined, { numeric: true }))
    });
  }

  return result;
}

function formatValue(data, oid) {
  if (data.value === null || data.value === undefined) return null;
  const enumLabel = ENUM_VALUES[oid]?.[String(data.value)];
  if (enumLabel) return enumLabel;
  return data.unit ? `${data.value} ${data.unit}` : String(data.value);
}

async function setProgram(profile, name, programName) {
  const object = (await listObjects(profile)).find((candidate) => normalize(candidate.name) === normalize(name));
  if (!object) {
    throw new Error(`Unknown heating object: ${name}`);
  }

  const value = PROGRAM_VALUES[programName] || String(programName).replace(/^Program\s+/i, '');
  if (!/^[0-8]$/.test(value)) {
    throw new Error(`Unsupported program "${programName}"`);
  }

  const programResult = await request(profile, 'PUT', datapointPath(profile, object, '3/50', value));
  const clearOverrideResult = await request(profile, 'PUT', datapointPath(profile, object, '2/10', '0'));
  return { object: object.name, program: ENUM_VALUES['3/50'][value] || value, responses: [programResult, clearOverrideResult] };
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (queue.length) {
      await worker(queue.shift());
    }
  });
  await Promise.all(workers);
}

function doctor(profile) {
  const cachedToken = readCachedToken(profile);
  const activeToken = profile.authToken || cachedToken;
  const expiry = tokenExpiryMs(activeToken);
  return [
    { name: 'baseUrl', ok: Boolean(profile.baseUrl), value: profile.baseUrl || null },
    { name: 'systemId', ok: Boolean(profile.systemId), value: profile.systemId || null },
    { name: 'auth token', ok: Boolean(profile.authToken), value: profile.authToken ? 'set via env/profile' : 'not set' },
    { name: 'cached token', ok: Boolean(cachedToken), value: cachedToken ? 'set' : 'missing' },
    { name: 'login credentials', ok: Boolean(profile.email && profile.password), value: profile.email ? `email set: ${profile.email}` : 'missing' },
    { name: 'token expiry', ok: !activeToken || isUsableToken(activeToken, profile), value: expiry ? new Date(expiry).toISOString() : 'unknown' },
    { name: 'deviceIdentifier', ok: Boolean(profile.deviceIdentifier), value: profile.deviceIdentifier ? 'set' : 'missing' }
  ];
}

function printHelp() {
  console.log([
    'Usage:',
    '  node windhager-mycomfort-iobroker.js profile-template > windhager-ios-profile.json',
    '  node windhager-mycomfort-iobroker.js doctor --profile windhager-ios-profile.json',
    '  node windhager-mycomfort-iobroker.js login --profile windhager-ios-profile.json',
    '  node windhager-mycomfort-iobroker.js list --profile windhager-ios-profile.json',
    '  node windhager-mycomfort-iobroker.js values --profile windhager-ios-profile.json',
    '  node windhager-mycomfort-iobroker.js set-program --profile windhager-ios-profile.json --name "Fussboden West" --program "Program 1"',
    '',
    'Auth:',
    '  WINDHAGER_EMAIL=<email> WINDHAGER_PASSWORD=<password>',
    '  or WINDHAGER_AUTH=<X-Comfort-Auth token>'
  ].join('\n'));
}

async function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';

  if (command === 'help' || args.help) {
    printHelp();
    return;
  }

  if (command === 'profile-template') {
    console.log(JSON.stringify(DEFAULT_PROFILE, null, 2));
    return;
  }

  const profile = loadProfile(args.profile || DEFAULT_PROFILE_PATH);

  if (command === 'doctor') {
    console.log(JSON.stringify(doctor(profile), null, 2));
    return;
  }

  if (command === 'login') {
    const token = await getAuthToken(profile, { forceLogin: true });
    const expiry = tokenExpiryMs(token);
    console.log(JSON.stringify({ ok: true, expiresAt: expiry ? new Date(expiry).toISOString() : null, cache: profile.tokenCachePath }, null, 2));
    return;
  }

  if (command === 'list') {
    console.log(JSON.stringify(await listObjects(profile), null, 2));
    return;
  }

  if (command === 'values') {
    console.log(JSON.stringify(await listValues(profile), null, 2));
    return;
  }

  if (command === 'set-program') {
    console.log(JSON.stringify(await setProgram(profile, args.name, args.program), null, 2));
    return;
  }

  throw new Error(`Unknown command "${command}"`);
}

const IOBROKER_DATAPOINTS = new Map();

async function ensureStates() {
  await cleanupLegacyStates();
  await createStateAsync(STATES.online, false, { name: 'Windhager online', type: 'boolean', role: 'indicator.connected', read: true, write: false });
  await createStateAsync(STATES.lastRefresh, '', { name: 'Windhager last refresh', type: 'string', role: 'date', read: true, write: false });
  await createStateAsync(STATES.lastError, '', { name: 'Windhager last error', type: 'string', role: 'text', read: true, write: false });
  await createStateAsync(STATES.apiBaseUrl, DEFAULT_PROFILE.baseUrl, { name: 'Windhager API base URL', type: 'string', role: 'text', read: true, write: false });
  await createStateAsync(STATES.authToken, '', { name: 'Windhager auth token', type: 'string', role: 'text', read: true, write: true });
  await createStateAsync(STATES.authTokenExpiresAt, '', { name: 'Windhager auth token expiry', type: 'string', role: 'date', read: true, write: false });
  await createStateAsync(STATES.systemId, DEFAULT_PROFILE.systemId, { name: 'Windhager system ID', type: 'string', role: 'text', read: true, write: true });
  await createStateAsync(STATES.deviceIdentifier, DEFAULT_PROFILE.deviceIdentifier, { name: 'Windhager device identifier', type: 'string', role: 'text', read: true, write: true });
  await createStateAsync(STATES.readConcurrency, DEFAULT_PROFILE.readConcurrency, { name: 'Windhager read concurrency', type: 'number', role: 'value', min: 1, max: 10, read: true, write: true });
  await createStateAsync(STATES.timeoutMs, DEFAULT_PROFILE.timeoutMs, { name: 'Windhager request timeout', type: 'number', role: 'value', unit: 'ms', min: 1000, read: true, write: true });
  await createStateAsync(STATES.refreshIntervalSec, 300, { name: 'Windhager refresh interval', type: 'number', role: 'value.interval', unit: 's', min: 0, read: true, write: true });
}

async function cleanupLegacyStates() {
  for (const id of LEGACY_STATES) {
    try {
      if (typeof deleteStateAsync === 'function') {
        await deleteStateAsync(id);
      } else if (typeof delObjectAsync === 'function') {
        await delObjectAsync(id);
      }
    } catch (_error) {
      // Legacy objects are optional and may already be absent.
    }
  }
}

async function getStateValue(id, fallback) {
  const state = await getStateAsync(id);
  return state && state.val !== null && state.val !== undefined && state.val !== '' ? state.val : fallback;
}

async function readIoBrokerProfile() {
  const token = String(await getStateValue(STATES.authToken, '') || '');
  return normalizeProfile({
    baseUrl: DEFAULT_PROFILE.baseUrl,
    systemId: String(await getStateValue(STATES.systemId, DEFAULT_PROFILE.systemId)),
    deviceIdentifier: String(await getStateValue(STATES.deviceIdentifier, DEFAULT_PROFILE.deviceIdentifier)),
    readConcurrency: Number(await getStateValue(STATES.readConcurrency, DEFAULT_PROFILE.readConcurrency)),
    timeoutMs: Number(await getStateValue(STATES.timeoutMs, DEFAULT_PROFILE.timeoutMs)),
    tokenRefreshSkewSeconds: DEFAULT_PROFILE.tokenRefreshSkewSeconds,
    tokenCachePath: DEFAULT_PROFILE.tokenCachePath,
    sessionPath: DEFAULT_PROFILE.sessionPath,
    headers: DEFAULT_PROFILE.headers,
    authToken: token
  });
}

async function syncAuthStates(profile) {
  const token = profile.authToken || readCachedToken(profile);
  await setStateAsync(STATES.authToken, token || '', true);
  const expiry = tokenExpiryMs(token);
  await setStateAsync(STATES.authTokenExpiresAt, expiry ? new Date(expiry).toISOString() : '', true);
}

async function ensureDeviceValueStates(objects) {
  for (const object of objects) {
    const deviceId = `${STATE_ROOT}.devices.${slugify(object.name)}`;
    for (const property of object.properties) {
      const stateId = `${deviceId}.${slugify(property.name)}`;
      const writable = WRITABLE_OIDS.has(property.oid);
      const enumStates = ENUM_VALUES[property.oid];
      const common = {
        name: property.name,
        type: writable || enumStates ? 'number' : 'mixed',
        role: stateRole(property, writable),
        read: true,
        write: writable
      };
      if (property.unit) common.unit = property.unit;
      if (enumStates) common.states = enumStates;
      await createStateAsync(stateId, null, common, {
        deviceName: object.name,
        nodeName: object.nodeName,
        nodeId: object.nodeId,
        functionId: object.functionId,
        oid: property.oid
      });
      IOBROKER_DATAPOINTS.set(stateId, { object, property, writable });
    }
  }
}

function stateRole(property, writable) {
  if (property.unit === '°C') return writable ? 'level.temperature' : 'value.temperature';
  if (property.unit === '%') return writable ? 'level' : 'value';
  if (ENUM_VALUES[property.oid]) return writable ? 'level.mode' : 'value';
  return writable ? 'level' : 'value';
}

async function refreshIoBrokerValues() {
  const profile = await readIoBrokerProfile();
  const objects = await listRawValues(profile);
  await ensureDeviceValueStates(objects);
  let errorCount = 0;

  for (const object of objects) {
    for (const property of object.properties) {
      const stateId = `${STATE_ROOT}.devices.${slugify(object.name)}.${slugify(property.name)}`;
      if (property.error) {
        errorCount += 1;
            await setStateAsync(stateId, null, true);
        continue;
      }
      await setStateAsync(stateId, normalizeStateValue(property.value), true);
    }
  }

  await syncAuthStates(profile);
  await setStateAsync(STATES.apiBaseUrl, profile.baseUrl, true);
  await setStateAsync(STATES.online, true, true);
  await setStateAsync(STATES.lastRefresh, new Date().toISOString(), true);
  await setStateAsync(STATES.lastError, errorCount ? `${errorCount} datapoint(s) could not be read` : '', true);
}

async function writeIoBrokerDatapoint(id, value) {
  const mapping = IOBROKER_DATAPOINTS.get(id);
  if (!mapping || !mapping.writable) return;

  const profile = await readIoBrokerProfile();
  const writeValue = writeValueForOid(mapping.property.oid, value);
  await request(profile, 'PUT', datapointPath(profile, mapping.object, mapping.property.oid, writeValue));
  if (mapping.property.oid === '3/50') {
    await request(profile, 'PUT', datapointPath(profile, mapping.object, '2/10', '0'));
  }
  await syncAuthStates(profile);
  await setStateAsync(id, normalizeStateValue(writeValue), true);
  await setStateAsync(STATES.online, true, true);
  await setStateAsync(STATES.lastError, '', true);
}

function writeValueForOid(oid, value) {
  if (oid === '3/50') {
    const program = PROGRAM_VALUES[String(value)] || String(value).replace(/^Program\s+/i, '');
    if (!/^[0-8]$/.test(program)) {
      throw new Error(`Unsupported heating program "${value}"`);
    }
    return program;
  }
  return value;
}

function normalizeStateValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return value;
}

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'unknown';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ioBrokerMain() {
  await ensureStates();
  await refreshIoBrokerValues();

  on({ id: new RegExp(`^${escapeRegExp(STATE_ROOT)}\\.devices\\.`), ack: false }, async (event) => {
    try {
      await writeIoBrokerDatapoint(event.id, event.state?.val);
    } catch (error) {
      await setStateAsync(STATES.online, false, true);
      await setStateAsync(STATES.lastError, error.message, true);
      log(`Windhager write failed: ${error.message}`, 'error');
    }
  });

  const intervalSec = Number(await getStateValue(STATES.refreshIntervalSec, 300));
  if (intervalSec > 0) {
    setInterval(async () => {
      try {
        await refreshIoBrokerValues();
      } catch (error) {
        await setStateAsync(STATES.online, false, true);
        await setStateAsync(STATES.lastError, error.message, true);
        log(`Windhager refresh failed: ${error.message}`, 'error');
      }
    }, intervalSec * 1000);
  }
}

if (require.main === module) {
  cliMain().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else if (typeof createStateAsync === 'function') {
  ioBrokerMain().catch(async (error) => {
    await setStateAsync(STATES.online, false, true);
    await setStateAsync(STATES.lastError, error.message, true);
    log(`Windhager startup failed: ${error.message}`, 'error');
  });
}

module.exports = {
  DEFAULT_PROFILE,
  ENUM_VALUES,
  PROGRAM_VALUES,
  WRITABLE_OIDS,
  datapointPath,
  doctor,
  isUsableToken,
  listObjects,
  listRawValues,
  listValues,
  normalizeProfile,
  request,
  setProgram,
  tokenExpiryMs
};
