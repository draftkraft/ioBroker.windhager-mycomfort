'use strict';

const utils = require('@iobroker/adapter-core');
const {
  DEFAULT_PROFILE,
  ENUM_VALUES,
  PROGRAM_VALUES,
  WRITABLE_OIDS,
  datapointPath,
  isUsableToken,
  listRawValues,
  normalizeProfile,
  request,
  tokenExpiryMs
} = require('./windhager-mycomfort-iobroker');

const INFO_STATES = {
  online: 'info.online',
  lastRefresh: 'info.lastRefresh',
  lastError: 'info.lastError',
  apiBaseUrl: 'info.apiBaseUrl'
};

const AUTH_STATES = {
  token: 'auth.token',
  tokenExpiresAt: 'auth.tokenExpiresAt'
};

const SETTINGS_STATES = {
  systemId: 'settings.systemId',
  deviceIdentifier: 'settings.deviceIdentifier',
  readConcurrency: 'settings.readConcurrency',
  timeoutMs: 'settings.timeoutMs',
  refreshIntervalSec: 'settings.refreshIntervalSec'
};

class WindhagerMycomfort extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: 'windhager-mycomfort'
    });

    this.datapoints = new Map();
    this.refreshTimer = null;
    this.refreshRunning = false;

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    await this.ensureBaseStates();
    await this.subscribeStatesAsync('devices.*');
    await this.refreshValues();
    await this.scheduleRefresh();
  }

  onUnload(callback) {
    try {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
      callback();
    } catch (_error) {
      callback();
    }
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;
    const relId = this.relativeId(id);
    const mapping = this.datapoints.get(relId);
    if (!mapping || !mapping.writable) return;

    try {
      await this.writeDatapoint(relId, state.val);
    } catch (error) {
      await this.setStateAsync(INFO_STATES.online, false, true);
      await this.setStateAsync(INFO_STATES.lastError, error.message, true);
      this.log.error(`Windhager write failed: ${error.message}`);
    }
  }

  async ensureBaseStates() {
    await this.setObjectNotExistsAsync('info', {
      type: 'channel',
      common: { name: 'Information' },
      native: {}
    });
    await this.setObjectNotExistsAsync('auth', {
      type: 'channel',
      common: { name: 'Authentication' },
      native: {}
    });
    await this.setObjectNotExistsAsync('settings', {
      type: 'channel',
      common: { name: 'Settings' },
      native: {}
    });
    await this.setObjectNotExistsAsync('devices', {
      type: 'channel',
      common: { name: 'Devices' },
      native: {}
    });
    await this.setObjectNotExistsAsync(INFO_STATES.online, {
      type: 'state',
      common: { name: 'Windhager online', type: 'boolean', role: 'indicator.connected', read: true, write: false },
      native: {}
    });
    await this.setObjectNotExistsAsync(INFO_STATES.lastRefresh, {
      type: 'state',
      common: { name: 'Windhager last refresh', type: 'string', role: 'date', read: true, write: false },
      native: {}
    });
    await this.setObjectNotExistsAsync(INFO_STATES.lastError, {
      type: 'state',
      common: { name: 'Windhager last error', type: 'string', role: 'text', read: true, write: false },
      native: {}
    });
    await this.setObjectNotExistsAsync(INFO_STATES.apiBaseUrl, {
      type: 'state',
      common: { name: 'Windhager API base URL', type: 'string', role: 'text', read: true, write: false },
      native: {}
    });
    await this.setObjectNotExistsAsync(AUTH_STATES.token, {
      type: 'state',
      common: { name: 'Windhager auth token', type: 'string', role: 'text', read: true, write: true },
      native: {}
    });
    await this.setObjectNotExistsAsync(AUTH_STATES.tokenExpiresAt, {
      type: 'state',
      common: { name: 'Windhager auth token expiry', type: 'string', role: 'date', read: true, write: false },
      native: {}
    });
    await this.ensureSettingState(SETTINGS_STATES.systemId, 'Windhager system ID', 'string', this.config.systemId || DEFAULT_PROFILE.systemId);
    await this.ensureSettingState(SETTINGS_STATES.deviceIdentifier, 'Windhager device identifier', 'string', this.config.deviceIdentifier || DEFAULT_PROFILE.deviceIdentifier);
    await this.ensureSettingState(SETTINGS_STATES.readConcurrency, 'Windhager read concurrency', 'number', Number(this.config.readConcurrency || DEFAULT_PROFILE.readConcurrency), { min: 1, max: 10 });
    await this.ensureSettingState(SETTINGS_STATES.timeoutMs, 'Windhager request timeout', 'number', Number(this.config.timeoutMs || DEFAULT_PROFILE.timeoutMs), { unit: 'ms', min: 1000 });
    await this.ensureSettingState(SETTINGS_STATES.refreshIntervalSec, 'Windhager refresh interval', 'number', Number(this.config.refreshIntervalSec || 300), { unit: 's', min: 0 });
    await this.setStateAsync(INFO_STATES.apiBaseUrl, DEFAULT_PROFILE.baseUrl, true);
  }

  async ensureSettingState(id, name, type, defaultValue, extra = {}) {
    await this.setObjectNotExistsAsync(id, {
      type: 'state',
      common: { name, type, role: 'value', read: true, write: true, ...extra },
      native: {}
    });
    const state = await this.getStateAsync(id);
    if (!state || state.val === null || state.val === undefined || state.val === '') {
      await this.setStateAsync(id, defaultValue, true);
    }
  }

  async readProfile() {
    const tokenState = await this.getStateAsync(AUTH_STATES.token);
    const token = String(tokenState?.val || '');
    return normalizeProfile({
      baseUrl: DEFAULT_PROFILE.baseUrl,
      systemId: String(await this.getStateValue(SETTINGS_STATES.systemId, this.config.systemId || DEFAULT_PROFILE.systemId)),
      deviceIdentifier: String(await this.getStateValue(SETTINGS_STATES.deviceIdentifier, this.config.deviceIdentifier || DEFAULT_PROFILE.deviceIdentifier)),
      readConcurrency: Number(await this.getStateValue(SETTINGS_STATES.readConcurrency, this.config.readConcurrency || DEFAULT_PROFILE.readConcurrency)),
      timeoutMs: Number(await this.getStateValue(SETTINGS_STATES.timeoutMs, this.config.timeoutMs || DEFAULT_PROFILE.timeoutMs)),
      tokenRefreshSkewSeconds: DEFAULT_PROFILE.tokenRefreshSkewSeconds,
      tokenCachePath: '',
      sessionPath: DEFAULT_PROFILE.sessionPath,
      headers: DEFAULT_PROFILE.headers,
      authToken: token,
      email: this.config.email || '',
      password: this.config.password || ''
    });
  }

  async getStateValue(id, fallback) {
    const state = await this.getStateAsync(id);
    return state && state.val !== null && state.val !== undefined && state.val !== '' ? state.val : fallback;
  }

  async syncAuthStates(profile) {
    const token = profile.authToken || '';
    await this.setStateAsync(AUTH_STATES.token, token, true);
    const expiry = tokenExpiryMs(token);
    await this.setStateAsync(AUTH_STATES.tokenExpiresAt, expiry ? new Date(expiry).toISOString() : '', true);
  }

  async refreshValues() {
    if (this.refreshRunning) return;
    this.refreshRunning = true;
    try {
      const profile = await this.readProfile();
      if (!isUsableToken(profile.authToken, profile) && !(profile.email && profile.password)) {
        throw new Error('Configure myComfort email/password in the adapter instance settings, or provide a valid auth.token state');
      }

      const objects = await listRawValues(profile);
      await this.ensureDeviceValueStates(objects);
      let errorCount = 0;

      for (const object of objects) {
        for (const property of object.properties) {
          const stateId = this.stateIdFor(object, property);
          if (property.error) {
            errorCount += 1;
            await this.setStateAsync(stateId, null, true);
            continue;
          }
          await this.setStateAsync(stateId, this.normalizeStateValue(property.value), true);
        }
      }

      await this.syncAuthStates(profile);
      await this.setStateAsync(INFO_STATES.online, true, true);
      await this.setStateAsync(INFO_STATES.lastRefresh, new Date().toISOString(), true);
      await this.setStateAsync(INFO_STATES.lastError, errorCount ? `${errorCount} datapoint(s) could not be read` : '', true);
    } catch (error) {
      await this.setStateAsync(INFO_STATES.online, false, true);
      await this.setStateAsync(INFO_STATES.lastError, error.message, true);
      this.log.error(`Windhager refresh failed: ${error.message}`);
    } finally {
      this.refreshRunning = false;
    }
  }

  async ensureDeviceValueStates(objects) {
    for (const object of objects) {
      const deviceId = `devices.${this.slugify(object.name)}`;
      await this.setObjectNotExistsAsync(deviceId, {
        type: 'channel',
        common: { name: object.name },
        native: {
          sourceName: object.name,
          nodeName: object.nodeName,
          nodeId: object.nodeId,
          functionId: object.functionId
        }
      });
      for (const property of object.properties) {
        const stateId = this.stateIdFor(object, property);
        const writable = WRITABLE_OIDS.has(property.oid);
        const enumStates = ENUM_VALUES[property.oid];
        const common = {
          name: property.name,
          type: writable || enumStates ? 'number' : 'mixed',
          role: this.stateRole(property, writable),
          read: true,
          write: writable
        };
        if (property.unit) common.unit = property.unit;
        if (enumStates) common.states = enumStates;
        await this.setObjectNotExistsAsync(stateId, {
          type: 'state',
          common,
          native: {
            deviceName: object.name,
            nodeName: object.nodeName,
            nodeId: object.nodeId,
            functionId: object.functionId,
            oid: property.oid
          }
        });
        this.datapoints.set(stateId, { object, property, writable });
      }
    }
  }

  async writeDatapoint(stateId, value) {
    const mapping = this.datapoints.get(stateId);
    if (!mapping || !mapping.writable) return;

    const profile = await this.readProfile();
    const writeValue = this.writeValueForOid(mapping.property.oid, value);
    await request(profile, 'PUT', datapointPath(profile, mapping.object, mapping.property.oid, writeValue));
    if (mapping.property.oid === '3/50') {
      await request(profile, 'PUT', datapointPath(profile, mapping.object, '2/10', '0'));
    }
    await this.syncAuthStates(profile);
    await this.setStateAsync(stateId, this.normalizeStateValue(writeValue), true);
    await this.setStateAsync(INFO_STATES.online, true, true);
    await this.setStateAsync(INFO_STATES.lastError, '', true);
  }

  async scheduleRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    const intervalSec = Number(await this.getStateValue(SETTINGS_STATES.refreshIntervalSec, this.config.refreshIntervalSec || 300));
    if (intervalSec > 0) {
      this.refreshTimer = setInterval(() => {
        this.refreshValues().catch((error) => this.log.error(`Windhager refresh failed: ${error.message}`));
      }, intervalSec * 1000);
    }
  }

  stateIdFor(object, property) {
    return `devices.${this.slugify(object.name)}.${this.slugify(property.name)}`;
  }

  stateRole(property, writable) {
    if (property.unit === '°C') return writable ? 'level.temperature' : 'value.temperature';
    if (property.unit === '%') return writable ? 'level' : 'value';
    if (ENUM_VALUES[property.oid]) return writable ? 'level.mode' : 'value';
    return writable ? 'level' : 'value';
  }

  writeValueForOid(oid, value) {
    if (oid === '3/50') {
      const program = PROGRAM_VALUES[String(value)] || String(value).replace(/^Program\s+/i, '');
      if (!/^[0-8]$/.test(program)) {
        throw new Error(`Unsupported heating program "${value}"`);
      }
      return program;
    }
    return value;
  }

  normalizeStateValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
      return Number(value);
    }
    return value;
  }

  slugify(value) {
    const slug = String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return slug || 'unknown';
  }

  relativeId(id) {
    const prefix = `${this.namespace}.`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }
}

if (module.parent) {
  module.exports = (options) => new WindhagerMycomfort(options);
} else {
  new WindhagerMycomfort();
}
