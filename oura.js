// ==================== OURA RING INTEGRATION ====================
// Discern App — Oura API v2 connector
//
// Setup:
// 1. Go to https://cloud.ouraring.com/oauth/applications
// 2. Create an application (redirect URI: your app URL + /callback, or use Personal Access Token)
// 3. Enter your Personal Access Token in the app's Settings screen
//
// The Oura API v2 provides: heart rate, HRV, sleep, readiness, daily activity

const OuraAPI = {
  BASE_URL: 'https://api.ouraring.com/v2/usercollection',

  getToken() {
    return localStorage.getItem('discern_oura_token') || '';
  },

  setToken(token) {
    localStorage.setItem('discern_oura_token', token.trim());
  },

  clearToken() {
    localStorage.removeItem('discern_oura_token');
    localStorage.removeItem('discern_oura_cache');
    localStorage.removeItem('discern_oura_baseline');
  },

  isConnected() {
    return !!this.getToken();
  },

  async fetch(endpoint, params = {}) {
    const token = this.getToken();
    if (!token) throw new Error('No Oura token configured');

    const url = new URL(`${this.BASE_URL}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const resp = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (resp.status === 401) {
      throw new Error('Invalid or expired Oura token. Please update in Settings.');
    }
    if (!resp.ok) {
      throw new Error(`Oura API error: ${resp.status}`);
    }

    return resp.json();
  },

  todayStr() {
    return new Date().toISOString().split('T')[0];
  },

  yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  },

  weekAgoStr() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split('T')[0];
  },

  // ---- Data fetchers ----

  async getHeartRate() {
    const data = await this.fetch('heartrate', {
      start_datetime: new Date(Date.now() - 3600000).toISOString(),
      end_datetime: new Date().toISOString()
    });
    return data.data || [];
  },

  async getDailyHRV() {
    const data = await this.fetch('daily_hrv', {
      start_date: this.yesterdayStr(),
      end_date: this.todayStr()
    });
    return data.data || [];
  },

  async getDailySleep() {
    const data = await this.fetch('daily_sleep', {
      start_date: this.yesterdayStr(),
      end_date: this.todayStr()
    });
    return data.data || [];
  },

  async getDailyReadiness() {
    const data = await this.fetch('daily_readiness', {
      start_date: this.yesterdayStr(),
      end_date: this.todayStr()
    });
    return data.data || [];
  },

  async getWeekHRV() {
    const data = await this.fetch('daily_hrv', {
      start_date: this.weekAgoStr(),
      end_date: this.todayStr()
    });
    return data.data || [];
  },

  // ---- Composite: get everything we need ----

  async getCurrentState() {
    try {
      const [heartRates, hrvData, sleepData, readinessData] = await Promise.all([
        this.getHeartRate().catch(() => []),
        this.getDailyHRV().catch(() => []),
        this.getDailySleep().catch(() => []),
        this.getDailyReadiness().catch(() => [])
      ]);

      // Most recent heart rate
      const latestHR = heartRates.length > 0
        ? heartRates[heartRates.length - 1].bpm
        : null;

      // Today's HRV (or most recent)
      const latestHRV = hrvData.length > 0
        ? hrvData[hrvData.length - 1]
        : null;

      // Sleep score
      const latestSleep = sleepData.length > 0
        ? sleepData[sleepData.length - 1]
        : null;

      // Readiness score
      const latestReadiness = readinessData.length > 0
        ? readinessData[readinessData.length - 1]
        : null;

      const state = {
        heartRate: latestHR,
        hrv: latestHRV ? (latestHRV.contributors?.rmssd || null) : null,
        hrvBaseline: latestHRV ? (latestHRV.contributors?.rmssd_baseline || null) : null,
        sleepScore: latestSleep ? latestSleep.score : null,
        readinessScore: latestReadiness ? latestReadiness.score : null,
        timestamp: new Date().toISOString(),
        raw: { heartRates, hrvData, sleepData, readinessData }
      };

      // Cache it
      localStorage.setItem('discern_oura_cache', JSON.stringify(state));

      return state;
    } catch (err) {
      console.error('Oura fetch error:', err);
      throw err;
    }
  },

  getCachedState() {
    try {
      return JSON.parse(localStorage.getItem('discern_oura_cache'));
    } catch {
      return null;
    }
  },

  // ---- Baseline tracking ----

  async updateBaseline() {
    try {
      const weekHRV = await this.getWeekHRV();
      if (weekHRV.length < 3) return null;

      const values = weekHRV
        .map(d => d.contributors?.rmssd)
        .filter(v => v != null);

      if (values.length === 0) return null;

      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const baseline = {
        hrvAvg: Math.round(avg),
        hrvMin: Math.min(...values),
        hrvMax: Math.max(...values),
        sampleSize: values.length,
        updatedAt: new Date().toISOString()
      };

      localStorage.setItem('discern_oura_baseline', JSON.stringify(baseline));
      return baseline;
    } catch (err) {
      console.error('Baseline update error:', err);
      return null;
    }
  },

  getBaseline() {
    try {
      return JSON.parse(localStorage.getItem('discern_oura_baseline'));
    } catch {
      return null;
    }
  },

  // ---- Elevation detection ----

  assessElevation(currentState) {
    const baseline = this.getBaseline();
    if (!baseline || !currentState) return null;

    const signals = [];
    let elevationScore = 0;

    // HRV below baseline
    if (currentState.hrv && baseline.hrvAvg) {
      const hrvDiff = ((currentState.hrv - baseline.hrvAvg) / baseline.hrvAvg) * 100;
      if (hrvDiff < -20) {
        signals.push({
          type: 'hrv_low',
          message: `Your HRV is ${Math.abs(Math.round(hrvDiff))}% below your baseline — your nervous system may be under load.`,
          severity: 'high'
        });
        elevationScore += 3;
      } else if (hrvDiff < -10) {
        signals.push({
          type: 'hrv_low',
          message: `Your HRV is slightly below baseline. Something may be building.`,
          severity: 'medium'
        });
        elevationScore += 1;
      }
    }

    // Elevated heart rate
    if (currentState.heartRate && currentState.heartRate > 85) {
      signals.push({
        type: 'hr_high',
        message: `Heart rate is elevated at ${currentState.heartRate} bpm.`,
        severity: currentState.heartRate > 95 ? 'high' : 'medium'
      });
      elevationScore += currentState.heartRate > 95 ? 3 : 1;
    }

    // Poor readiness
    if (currentState.readinessScore && currentState.readinessScore < 60) {
      signals.push({
        type: 'readiness_low',
        message: `Oura readiness score is ${currentState.readinessScore} — your system may not be at its best for high-stakes decisions.`,
        severity: 'medium'
      });
      elevationScore += 1;
    }

    // Poor sleep
    if (currentState.sleepScore && currentState.sleepScore < 60) {
      signals.push({
        type: 'sleep_poor',
        message: `Sleep score was ${currentState.sleepScore} last night. Low sleep impacts discernment — factor this in.`,
        severity: 'medium'
      });
      elevationScore += 1;
    }

    return {
      isElevated: elevationScore >= 2,
      elevationScore,
      signals,
      recommendation: elevationScore >= 3
        ? 'Your body is significantly activated. Consider waiting on major decisions, or extend your centering practice.'
        : elevationScore >= 2
        ? 'Some elevation detected. Proceed with extra awareness — your discernment may be partially compromised.'
        : 'Your baseline looks steady. Good conditions for clear decision-making.'
    };
  },

  // ---- Test connection ----

  async testConnection() {
    try {
      const data = await this.fetch('personal_info');
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};

// Make it globally available
window.OuraAPI = OuraAPI;
