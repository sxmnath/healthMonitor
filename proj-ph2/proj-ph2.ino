#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <MPU6050_tockn.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"
#include <Adafruit_TMP117.h>
#include <WiFiManager.h>
#include <WebSocketsClient.h>   // "WebSockets" by Markus Sattler — install via Library Manager

/* --- SERVER URL --- */
String serverURL = "https://health-monitor-server-2pbh.onrender.com/data";
const char* wsHost = "health-monitor-server-2pbh.onrender.com";  // same host, no https:// prefix
const int   wsPort = 443;
const char* wsPath = "/ecg-stream";

/* -------------------- LIVE ECG WEBSOCKET -------------------- */
// Streams each ECG sample batch to the server the moment sampleECG()
// finishes (every loop() iteration, ~1-2s cadence — see loop() timing
// notes below), instead of waiting for the 5s HTTP POST cycle. This is
// the same live ECG waveform the dashboard already renders — it just
// arrives faster and more often now. POST /data's own ecgWaveform field
// stays in place as a fallback for while this connection is (re)connecting.
WebSocketsClient ecgWs;
bool ecgWsBound = false;   // true once we've sent our deviceId to bind this connection

void onEcgWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[ecg-ws] connected — binding deviceId");
      ecgWs.sendTXT("{\"deviceId\":\"ESP32_01\"}");
      ecgWsBound = true;
      break;
    case WStype_DISCONNECTED:
      Serial.println("[ecg-ws] disconnected — will auto-reconnect");
      ecgWsBound = false;
      break;
    case WStype_ERROR:
      Serial.println("[ecg-ws] error");
      break;
    default:
      break;  // ignore TEXT/BIN/PING/PONG echoes — server doesn't send anything back
  }
}

/* -------------------- OBJECTS -------------------- */
MAX30105    particleSensor;
Adafruit_TMP117 tmp117;
MPU6050     mpu(Wire);        // I2C addr 0x68 (AD0 low, default)

/* -------------------- MAX30102 VARIABLES -------------------- */
uint32_t irBuffer[100];
uint32_t redBuffer[100];
int32_t  bufferLength = 100;

int32_t spo2;
int8_t  validSPO2;
int32_t maxHR;          // MAX30102 HR — algorithm needs it but value is DISCARDED
int8_t  validHeartRate; // not used — ECG is primary HR source

/* -------------------- TMP117 -------------------- */
float temperatureC = 0;

/* -------------------- ECG (AD8232) -------------------- */
// Wiring: OUTPUT → GPIO34 (ADC1 only — ADC2 conflicts with WiFi)
//         LO+    → GPIO32
//         LO-    → GPIO33
#define ECG_PIN     36   // GPIO36 (VP) — input-only, ADC1, confirmed working
#define LO_PLUS      2   // confirmed working in hardware test
#define LO_MINUS     4   // confirmed working in hardware test

#define ECG_SAMPLES   50      // samples per window (1s at 50Hz)
#define ECG_SAMPLE_MS 20      // 20ms between samples = 50Hz (confirmed in hardware test)
#define ECG_THRESHOLD 2500    // R-peak threshold — tune if peaks are missed (range: 2000–3000)
#define ECG_HYST      200     // hysteresis — prevents re-triggering on same peak

// R-peak detector state — persists across loop() iterations
bool          _ecgHigh    = false;
unsigned long _lastPeakMs = 0;

// Primary HR output — -1 = leads off or no valid reading
int ecgHeartRate = -1;

// Raw waveform buffer — the last 1-second window of raw AD8232 samples,
// captured alongside the existing R-peak detection loop below. Sent to the
// server each POST cycle so the web dashboard can render a live scrolling
// ECG trace (Serial-Plotter-style), separate from the derived BPM value.
int  ecgWaveform[ECG_SAMPLES];
bool ecgWaveformValid = false;  // false when leads are off — buffer is stale, don't send it

/* -------------------- MPU6050 VARIABLES -------------------- */
// Raw sensor readings
float accelX = 0, accelY = 0, accelZ = 0;  // g (gravity units)
float gyroX  = 0, gyroY  = 0, gyroZ  = 0;  // degrees/second

// Derived motion fields
float  activityScore  = 0.0;    // 0–100 from excess accel above 1g baseline
bool   motionDetected = false;  // true if magnitude > 1.2g
String posture        = "unknown";

/* -------------------- TIMING -------------------- */
unsigned long lastSendTime = 0;
const unsigned long sendInterval = 5000;

/* ================================================================
   sampleECG()
   Collects 50 samples at 500Hz, detects R-peaks, updates ecgHeartRate.

   R-peak detection:
     Rising edge crosses ECG_THRESHOLD → record millis() timestamp
     BPM = 60000 / interval between consecutive peaks
     Hysteresis: signal must fall ECG_HYST below threshold before
     next rising edge counts
     Stale guard: clears to -1 if no peak seen for 3s
   ================================================================ */
void sampleECG() {
  if (digitalRead(LO_PLUS) == HIGH || digitalRead(LO_MINUS) == HIGH) {
    ecgHeartRate = -1;
    _lastPeakMs  = 0;
    _ecgHigh     = false;
    ecgWaveformValid = false;   // leads off — don't send a stale/flat buffer
    return;
  }

  for (int i = 0; i < ECG_SAMPLES; i++) {
    int sample = analogRead(ECG_PIN);
    ecgWaveform[i] = sample;    // buffered for the live waveform display

    if (!_ecgHigh && sample > ECG_THRESHOLD) {
      _ecgHigh = true;
      unsigned long now      = millis();
      unsigned long interval = now - _lastPeakMs;
      if (_lastPeakMs > 0 && interval >= 300 && interval <= 2000) {
        ecgHeartRate = (int)(60000UL / interval);
      }
      _lastPeakMs = now;

    } else if (_ecgHigh && sample < (ECG_THRESHOLD - ECG_HYST)) {
      _ecgHigh = false;
    }

    delay(ECG_SAMPLE_MS);
  }
  ecgWaveformValid = true;

  // ── Live stream this batch immediately ─────────────────────────────────
  // This is the whole point of the WS connection over the old POST-only
  // approach: don't wait up to 5s for the next vitals POST, push this
  // window the moment it's ready.
  if (ecgWsBound) {
    ecgWs.sendTXT(buildEcgWaveformStreamMsg());
  }

  if (_lastPeakMs > 0 && (millis() - _lastPeakMs) > 3000) {
    ecgHeartRate = -1;
    _lastPeakMs  = 0;
  }
}

/* ================================================================
   readMPU()
   Reads accel + gyro from MPU6050, derives activity score,
   motion flag, and posture string.

   Activity score:
     magnitude = sqrt(ax² + ay² + az²)  — total acceleration in g
     excess    = magnitude - 1.0         — subtract gravity baseline
     score     = constrain(excess × 50, 0, 100)
     → at rest: score ≈ 0
     → walking: score ≈ 10–30
     → running / high movement: score → 100

   motionDetected:
     true when magnitude > 1.2g (0.2g above gravity baseline)

   Posture (gravity axis inference):
     az < -0.5g  → supine  (lying on back, sensor face-up)
     ax >  0.8g  → lateral (on side)
     else        → upright  (sitting, standing, or ambiguous)
     Note: thresholds assume sensor mounted on chest/wrist face-up.
     Adjust signs if your mounting orientation differs.
   ================================================================ */
void readMPU() {
  mpu.update();

  accelX = mpu.getAccX();
  accelY = mpu.getAccY();
  accelZ = mpu.getAccZ();
  gyroX  = mpu.getGyroX();
  gyroY  = mpu.getGyroY();
  gyroZ  = mpu.getGyroZ();

  float magnitude = sqrt(accelX*accelX + accelY*accelY + accelZ*accelZ);
  float excess    = magnitude - 1.0;
  if (excess < 0) excess = 0;
  activityScore  = constrain(excess * 50.0, 0.0, 100.0);
  motionDetected = (magnitude > 1.2);

  if      (accelZ < -0.5) posture = "supine";
  else if (accelX >  0.8) posture = "lateral";
  else                    posture = "upright";
}

/* ================================================================
   buildEcgWaveformJson()
   Serialises ecgWaveform[] to a JSON array string, e.g. "[512,514,...]".
   Returns "[]" when the buffer isn't valid (leads off) — the server/
   dashboard already treat an empty array as "no live signal".
   ================================================================ */
String buildEcgWaveformJson() {
  if (!ecgWaveformValid) return "[]";
  String out = "[";
  for (int i = 0; i < ECG_SAMPLES; i++) {
    out += String(ecgWaveform[i]);
    if (i < ECG_SAMPLES - 1) out += ",";
  }
  out += "]";
  return out;
}

/* ================================================================
   buildEcgWaveformStreamMsg()
   Builds the WS message sent over /ecg-stream: {"samples":[...],"sampleRate":50}
   Only called when ecgWaveformValid is already true, so no leads-off
   guard needed here (sampleECG() already handles that by not calling
   this at all when leads are off).
   ================================================================ */
String buildEcgWaveformStreamMsg() {
  String msg = "{\"samples\":" + buildEcgWaveformJson() + ",";
  msg += "\"sampleRate\":" + String(1000 / ECG_SAMPLE_MS) + "}";
  return msg;
}

/* -------------------- SETUP -------------------- */
void setup() {
  Serial.begin(115200);
  delay(1000);

  /* ---------- ECG PINS ---------- */
  // GPIO36 (ECG_PIN) is input-only on ESP32 — no pinMode needed
  pinMode(LO_PLUS,  INPUT);
  pinMode(LO_MINUS, INPUT);

  /* ---------- WIFI ---------- */
  WiFiManager wm;
  bool res = wm.autoConnect("HealthMonitor-Setup");
  if (!res) {
    Serial.println("WiFi Failed");
    ESP.restart();
  }
  Serial.println("WiFi Connected!");
  Serial.println(WiFi.localIP());

  /* ---------- I2C ---------- */
  Wire.begin(21, 22);

  /* ---------- MPU6050 ---------- */
  // Shares I2C bus with MAX30102 (0x57) and TMP117 (0x48) — no conflict
  // MPU6050 default address: 0x68 (AD0 pin low)
  mpu.begin();
  Serial.println("MPU6050 calibrating — hold device still...");
  mpu.calcGyroOffsets(true);  // ~3 second blocking calibration, prints progress
  Serial.println("MPU6050 ready");

  /* ---------- TMP117 ---------- */
  if (!tmp117.begin()) {
    Serial.println("TMP117 not found");
    while (1);
  }
  Serial.println("TMP117 initialized");

  /* ---------- MAX30102 (SpO2 only) ---------- */
  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 not found");
    while (1);
  }
  particleSensor.setup(
    60,    // LED brightness
    4,     // Sample averaging
    2,     // Red + IR
    100,   // Sample rate
    411,   // Pulse width
    4096   // ADC range
  );
  Serial.println("MAX30102 initialized (SpO2 only — HR from ECG)");
  Serial.println("AD8232 ready — attach electrodes");

  /* ---------- LIVE ECG WEBSOCKET ---------- */
  ecgWs.beginSSL(wsHost, wsPort, wsPath);
  ecgWs.onEvent(onEcgWsEvent);
  ecgWs.setReconnectInterval(5000);
  Serial.println("[ecg-ws] connecting...");
}

/* -------------------- LOOP -------------------- */
void loop() {

  /* ---------- 0. SERVICE ECG WEBSOCKET (non-blocking) ---------- */
  ecgWs.loop();

  /* ---------- 1. SAMPLE ECG ---------- */
  // 50 samples × 2ms = 100ms
  sampleECG();

  /* ---------- 2. READ MPU6050 ---------- */
  // Fast — no blocking. Updates accel, gyro, activityScore, posture, motionDetected
  readMPU();

  /* ---------- 3. COLLECT MAX30102 SAMPLES ---------- */
  // SpO2 only — blocks ~1 second (100 samples at 100Hz)
  for (byte i = 0; i < bufferLength; i++) {
    while (!particleSensor.available()) {
      particleSensor.check();
    }
    redBuffer[i] = particleSensor.getRed();
    irBuffer[i]  = particleSensor.getIR();
    particleSensor.nextSample();
  }

  /* ---------- 4. CALCULATE SPO2 ---------- */
  // maxHR populated by algorithm but not used
  maxim_heart_rate_and_oxygen_saturation(
    irBuffer, bufferLength,
    redBuffer,
    &spo2, &validSPO2,
    &maxHR, &validHeartRate
  );

  /* ---------- 5. READ TMP117 ---------- */
  sensors_event_t tempEvent;
  tmp117.getEvent(&tempEvent);
  temperatureC = tempEvent.temperature;

  /* ---------- 6. FINAL VALUES ---------- */
  int finalSpO2 = validSPO2 ? spo2 : -1;
  // ecgHeartRate is already -1 if leads off or stale — use directly

  /* ---------- 7. SERIAL DEBUG ---------- */
  bool leadsOff = (digitalRead(LO_PLUS) || digitalRead(LO_MINUS));
  Serial.print("Temp: ");        Serial.print(temperatureC, 2);
  Serial.print("C | ECG HR: ");  Serial.print(ecgHeartRate);
  Serial.print(" BPM | SpO2: "); Serial.print(finalSpO2);
  Serial.print("% | Leads: ");   Serial.print(leadsOff ? "OFF" : "ON");
  Serial.print(" | Activity: "); Serial.print(activityScore, 1);
  Serial.print(" | Posture: ");  Serial.print(posture);
  Serial.print(" | Motion: ");   Serial.println(motionDetected ? "YES" : "NO");

  /* ---------- 8. SEND TO SERVER EVERY 5s ---------- */
  if (millis() - lastSendTime >= sendInterval && WiFi.status() == WL_CONNECTED) {
    lastSendTime = millis();

    HTTPClient http;
    http.begin(serverURL);
    http.addHeader("Content-Type", "application/json");

    String jsonData = "{";
    jsonData += "\"ecgHR\":"         + String(ecgHeartRate)         + ",";
    jsonData += "\"heartRate\":"     + String(ecgHeartRate)         + ",";
    jsonData += "\"spo2\":"          + String(finalSpO2)            + ",";
    jsonData += "\"temperature\":"   + String(temperatureC, 2)      + ",";
    jsonData += "\"accelX\":"        + String(accelX, 3)            + ",";
    jsonData += "\"accelY\":"        + String(accelY, 3)            + ",";
    jsonData += "\"accelZ\":"        + String(accelZ, 3)            + ",";
    jsonData += "\"gyroX\":"         + String(gyroX, 2)             + ",";
    jsonData += "\"gyroY\":"         + String(gyroY, 2)             + ",";
    jsonData += "\"gyroZ\":"         + String(gyroZ, 2)             + ",";
    jsonData += "\"activityScore\":" + String(activityScore, 1)     + ",";
    jsonData += "\"posture\":\""     + posture                      + "\",";
    jsonData += "\"motionDetected\":" + String(motionDetected ? "true" : "false") + ",";
    jsonData += "\"ecgWaveform\":"   + buildEcgWaveformJson()       + ",";
    jsonData += "\"ecgSampleRate\":" + String(1000 / ECG_SAMPLE_MS) + ",";
    jsonData += "\"deviceId\":\"ESP32_01\"";
    jsonData += "}";

    // TEMP DEBUG — confirm the waveform array is actually in the outgoing
    // payload before it leaves the device. Remove once confirmed working.
    Serial.print("[waveform] valid=");
    Serial.print(ecgWaveformValid ? "YES" : "NO");
    Serial.print(" | payload bytes=");
    Serial.println(jsonData.length());

    int response = http.POST(jsonData);
    Serial.print("HTTP Response: ");
    Serial.println(response);

    http.end();
  }
}
