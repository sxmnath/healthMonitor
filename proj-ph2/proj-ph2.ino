#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"
#include <Adafruit_TMP117.h>
#include <WiFiManager.h>

String serverURL = "https://health-monitor-server-2pbh.onrender.com/data"; 

/* -------------------- OBJECTS -------------------- */
MAX30105 particleSensor;
Adafruit_TMP117 tmp117;

/* -------------------- MAX30102 VARIABLES -------------------- */
uint32_t irBuffer[100];
uint32_t redBuffer[100];
int32_t bufferLength = 100;

int32_t spo2;
int8_t validSPO2;
int32_t heartRate;
int8_t validHeartRate;

/* -------------------- TMP117 -------------------- */
float temperatureC = 0;

/* -------------------- TIMING -------------------- */
unsigned long lastSendTime = 0;
const unsigned long sendInterval = 5000;

/* -------------------- SETUP -------------------- */
void setup() {
  Serial.begin(115200);
  delay(1000);

  /* ---------- WIFI ---------- */

WiFiManager wm;

bool res = wm.autoConnect("HealthMonitor-Setup");

if(!res) {
  Serial.println("WiFi Failed");
  ESP.restart();
}

Serial.println("WiFi Connected!");
Serial.println(WiFi.localIP());

  /* ---------- I2C ---------- */
  Wire.begin(21, 22);

  /* ---------- TMP117 ---------- */
  if (!tmp117.begin()) {
    Serial.println("TMP117 not found");
    while (1);
  }
  Serial.println("TMP117 initialized");

  /* ---------- MAX30102 ---------- */
  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println(" MAX30102 not found");
    while (1);
  }

  particleSensor.setup(
    60,     // LED brightness
    4,      // Sample averaging
    2,      // Red + IR
    100,    // Sample rate
    411,    // Pulse width
    4096    // ADC range
  );

  Serial.println(" MAX30102 initialized");
  Serial.println(" Place finger on sensor");
}

/* -------------------- LOOP -------------------- */
void loop() {

  /* ---------- COLLECT MAX30102 SAMPLES ---------- */
  for (byte i = 0; i < bufferLength; i++) {
    while (!particleSensor.available()) {
      particleSensor.check();
    }

    redBuffer[i] = particleSensor.getRed();
    irBuffer[i]  = particleSensor.getIR();
    particleSensor.nextSample();
  }

  /* ---------- CALCULATE HR & SPO2 ---------- */
  maxim_heart_rate_and_oxygen_saturation(
    irBuffer, bufferLength,
    redBuffer,
    &spo2, &validSPO2,
    &heartRate, &validHeartRate
  );

  /* ---------- READ TMP117 ---------- */
  sensors_event_t tempEvent;
  tmp117.getEvent(&tempEvent);
  temperatureC = tempEvent.temperature;

  /* ---------- VALIDATED VALUES ---------- */
  int finalHR   = validHeartRate ? heartRate : -1;
  int finalSpO2 = validSPO2 ? spo2 : -1;

  /* ---------- SERIAL DEBUG ---------- */
  Serial.print("Temp: ");
  Serial.print(temperatureC, 2);
  Serial.print(" °C | HR: ");
  Serial.print(finalHR);
  Serial.print(" | SpO2: ");
  Serial.println(finalSpO2);

  /* ---------- SEND TO DB EVERY 5s ---------- */
  if (millis() - lastSendTime >= sendInterval && WiFi.status() == WL_CONNECTED) {
    lastSendTime = millis();

    HTTPClient http;
    http.begin(serverURL);
    http.addHeader("Content-Type", "application/json");

    String jsonData = "{";
    jsonData += "\"temperature\":" + String(temperatureC, 2) + ",";
    jsonData += "\"heartRate\":" + String(finalHR) + ",";
    jsonData += "\"spo2\":" + String(finalSpO2) + ",";
    jsonData += "\"deviceId\":\"ESP32_01\"";
    jsonData += "}";

    int response = http.POST(jsonData);
    Serial.print(" HTTP Response: ");
    Serial.println(response);

    http.end();
  }
}
