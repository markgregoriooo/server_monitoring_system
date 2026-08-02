/*
  FIXED VERSION
  Your IRremoteESP8266 library version does not support:
    results->frequency

  So we use a manually selected frequency instead.
  Most aircons use 38kHz, some use 36kHz.

  START WITH:
    detectedFrequency = 38;

  If your AC does not respond:
    change to 36
*/

// =========================
// LIBRARIES
// =========================
#include <IRremoteESP8266.h>
#include <IRrecv.h>
#include <IRsend.h>
#include <IRutils.h>

// =========================
// GPIO CONFIG
// =========================
const uint16_t IR_RECV_PIN = 15;
const uint16_t IR_SEND_PIN = 19;
const uint8_t BUTTON_PIN = 4;
const uint8_t BUZZER_PIN = 2;

// =========================
// SETTINGS
// =========================
const uint16_t kCaptureBufferSize = 2048;
const uint8_t kTimeout = 50;

// =========================
// OBJECTS
// =========================
IRrecv irrecv(IR_RECV_PIN, kCaptureBufferSize, kTimeout, true);
IRsend irsend(IR_SEND_PIN);

decode_results results;

// =========================
// STORAGE
// =========================
uint16_t capturedRaw[2048];
uint16_t rawLength = 0;

// TRY 38 FIRST
// IF NOT WORKING -> CHANGE TO 36
uint16_t detectedFrequency = 38;

bool signalCaptured = false;
bool learningMode = false;

// =========================
// BEEP
// =========================
void beep(uint16_t duration = 100) {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(duration);
  digitalWrite(BUZZER_PIN, LOW);
}

// =========================
// NORMALIZE
// =========================
uint16_t normalize(uint16_t value) {
  return ((value + 25) / 50) * 50;
}

// =========================
// CAPTURE RAW
// =========================
void captureRaw(decode_results *results) {

  rawLength = 0;

  for (uint16_t i = 1; i < results->rawlen; i++) {

    uint32_t usecs = results->rawbuf[i] * kRawTick;

    usecs = normalize(usecs);

    if (rawLength < 2048) {
      capturedRaw[rawLength++] = usecs;
    }
  }

  signalCaptured = true;
}

// =========================
// PRINT RAW
// =========================
void printRawArray() {

  Serial.println("\n========== CAPTURED RAW ==========");

  Serial.print("Frequency: ");
  Serial.print(detectedFrequency);
  Serial.println(" kHz");

  Serial.print("Raw Length: ");
  Serial.println(rawLength);

  Serial.println("\nuint16_t rawData[] = {");

  for (uint16_t i = 0; i < rawLength; i++) {

    Serial.print(capturedRaw[i]);

    if (i < rawLength - 1)
      Serial.print(", ");

    if ((i + 1) % 8 == 0)
      Serial.println();
  }

  Serial.println("};");

  Serial.println("==================================");
}

// =========================
// REPLAY
// =========================
void replaySignal() {

  if (!signalCaptured) {
    Serial.println("No signal stored!");
    return;
  }

  Serial.println("\nREPLAYING SIGNAL...");
  Serial.print("Frequency: ");
  Serial.print(detectedFrequency);
  Serial.println(" kHz");

  beep(200);

  // Send twice for AC reliability
  irsend.sendRaw(capturedRaw, rawLength, detectedFrequency);
  delay(40);
  irsend.sendRaw(capturedRaw, rawLength, detectedFrequency);

  Serial.println("Replay complete.");
}

// =========================
// SETUP
// =========================
void setup() {

  Serial.begin(115200);

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);

  irrecv.enableIRIn();
  irsend.begin();

  Serial.println("\n=================================");
  Serial.println("FLIPPER STYLE AC IR TOOL READY");
  Serial.println("=================================");
  Serial.println("HOLD button = Capture");
  Serial.println("SHORT press = Replay");
}

// =========================
// LOOP
// =========================
void loop() {

  static unsigned long pressStart = 0;
  static bool lastButtonState = HIGH;

  bool currentButton = digitalRead(BUTTON_PIN);

  // Button pressed
  if (lastButtonState == HIGH && currentButton == LOW) {
    pressStart = millis();
  }

  // Button released
  if (lastButtonState == LOW && currentButton == HIGH) {

    unsigned long pressDuration = millis() - pressStart;

    // LONG PRESS = LEARN
    if (pressDuration > 700) {

      learningMode = false;

      Serial.println("\n=== LEARNING MODE OFF ===");

    } else {

      // SHORT PRESS = REPLAY
      replaySignal();
    }
  }

  // HOLD BUTTON
  if (currentButton == LOW) {

    unsigned long holdTime = millis() - pressStart;

    // Enter learning mode
    if (holdTime > 700 && !learningMode) {

      learningMode = true;

      Serial.println("\n=== LEARNING MODE ON ===");
      Serial.println("Waiting for IR signal...");

      beep(80);
    }

    // Capture IR
    if (learningMode && irrecv.decode(&results)) {

      Serial.println("\nIR SIGNAL RECEIVED!");

      Serial.println(resultToHumanReadableBasic(&results));

      captureRaw(&results);

      printRawArray();

      beep(250);

      irrecv.resume();

      delay(500);
    }
  }

  lastButtonState = currentButton;
}