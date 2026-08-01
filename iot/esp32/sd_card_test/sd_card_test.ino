/*
 * ============================================================================
 *  SD CARD MODULE TEST  —  ESP32 + SPI microSD module
 * ============================================================================
 *  Standalone sketch to verify your microSD module + card are wired and
 *  working BEFORE you flip SD_ENABLED to true in env_monitor_v2.ino.
 *
 *  Uses the SAME pins as the real firmware, so a PASS here means offline
 *  logging will work in the main sketch.
 *
 *  ─── WIRING (SD module  ->  ESP32) ─────────────────────────────────────────
 *     SD module pin        ESP32 pin
 *     ----------------     ---------
 *       VCC / 5V           5V   (most modules have an onboard 3.3V regulator;
 *                                if yours is 3.3V-only, use the 3V3 pin)
 *       GND                GND
 *       MISO               GPIO 19
 *       MOSI               GPIO 23
 *       SCK / CLK          GPIO 18
 *       CS / SS            GPIO 5
 *
 *  ─── HOW TO USE ────────────────────────────────────────────────────────────
 *   1. Format the microSD as FAT32 (4GB cards are FAT32 by default — OK).
 *   2. Insert the card into the module.
 *   3. Wire it exactly as above.
 *   4. Flash this sketch (Board: "ESP32 Dev Module").
 *   5. Open Serial Monitor @ 115200 baud.
 *   6. Read the report. Look for ">>> ALL TESTS PASSED".
 * ============================================================================
 */

#include <SPI.h>
#include <SD.h>

/* ── Pins (match env_monitor_v2.ino) ── */
#define SD_SCK   18
#define SD_MISO  19
#define SD_MOSI  23
#define SD_CS    5

#define TEST_FILE "/sd_test.txt"

/* Helper: pretty-print a divider line */
void line() {
  Serial.println("------------------------------------------------------------");
}

/* Try SD.begin() at a few SPI speeds (some cheap modules/cards need slower) */
bool initSD() {
  uint32_t speeds[] = { 20000000, 10000000, 4000000, 1000000 };
  const char* labels[] = { "20 MHz", "10 MHz", "4 MHz", "1 MHz" };

  SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);

  for (int i = 0; i < 4; i++) {
    SD.end();
    if (SD.begin(SD_CS, SPI, speeds[i])) {
      Serial.printf("[OK] SD.begin() succeeded at %s\n", labels[i]);
      return true;
    }
    Serial.printf("[..] Failed at %s, trying slower...\n", labels[i]);
  }
  return false;
}

/* Print card type + size */
void printCardInfo() {
  uint8_t cardType = SD.cardType();

  Serial.print("Card type : ");
  switch (cardType) {
    case CARD_NONE: Serial.println("NONE (no card detected)"); return;
    case CARD_MMC:  Serial.println("MMC");     break;
    case CARD_SD:   Serial.println("SDSC");    break;
    case CARD_SDHC: Serial.println("SDHC");    break;
    default:        Serial.println("UNKNOWN"); break;
  }

  uint64_t cardSizeMB = SD.cardSize() / (1024ULL * 1024ULL);
  uint64_t usedMB     = SD.usedBytes() / (1024ULL * 1024ULL);
  uint64_t totalMB    = SD.totalBytes() / (1024ULL * 1024ULL);

  Serial.printf("Card size : %llu MB (~%.2f GB)\n", cardSizeMB, cardSizeMB / 1024.0);
  Serial.printf("FS total  : %llu MB\n", totalMB);
  Serial.printf("FS used   : %llu MB\n", usedMB);
}

/* WRITE test — create/overwrite a file */
bool testWrite() {
  Serial.print("[TEST] Write file...... ");
  File f = SD.open(TEST_FILE, FILE_WRITE);
  if (!f) { Serial.println("FAIL (could not open for write)"); return false; }
  f.println("Hello from ESP32 SD test!");
  f.println("Line 2: 1234567890");
  f.close();
  Serial.println("OK");
  return true;
}

/* READ test — read it back and show contents */
bool testRead() {
  Serial.print("[TEST] Read file....... ");
  File f = SD.open(TEST_FILE, FILE_READ);
  if (!f) { Serial.println("FAIL (could not open for read)"); return false; }
  Serial.println("OK");
  Serial.println("       --- file contents ---");
  while (f.available()) {
    Serial.print("       ");
    Serial.println(f.readStringUntil('\n'));
  }
  Serial.println("       ---------------------");
  f.close();
  return true;
}

/* APPEND test — mimics the firmware's offline-logging append */
bool testAppend() {
  Serial.print("[TEST] Append row...... ");
  File f = SD.open(TEST_FILE, FILE_APPEND);
  if (!f) { Serial.println("FAIL (could not open for append)"); return false; }
  f.println("Appended line OK");
  f.close();
  Serial.println("OK");
  return true;
}

/* DELETE test — clean up */
bool testDelete() {
  Serial.print("[TEST] Delete file..... ");
  if (!SD.exists(TEST_FILE)) { Serial.println("FAIL (file vanished?)"); return false; }
  if (!SD.remove(TEST_FILE)) { Serial.println("FAIL (remove failed)"); return false; }
  Serial.println("OK");
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  line();
  Serial.println("  ESP32 microSD MODULE TEST");
  line();
  Serial.printf("Pins: SCK=%d  MISO=%d  MOSI=%d  CS=%d\n",
                SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  line();

  /* 1. Initialize */
  if (!initSD()) {
    Serial.println();
    Serial.println(">>> SD INIT FAILED.");
    Serial.println("    Check these in order:");
    Serial.println("    1. Wiring (MISO<->19, MOSI<->23, SCK<->18, CS<->5, GND<->GND).");
    Serial.println("    2. Power — try 5V pin (module regulator) instead of 3V3.");
    Serial.println("    3. Card inserted fully + formatted FAT32.");
    Serial.println("    4. Bad/loose jumper wire (very common). Reseat all.");
    Serial.println("    5. Try a different CS pin if 5 is busy.");
    return;
  }

  line();
  printCardInfo();
  line();

  /* 2-5. File operations */
  bool ok = true;
  ok &= testWrite();
  ok &= testRead();
  ok &= testAppend();
  ok &= testRead();      // read again to confirm the append landed
  ok &= testDelete();

  line();
  if (ok) {
    Serial.println(">>> ALL TESTS PASSED  ✓");
    Serial.println("    Your SD module + card work. You can safely set");
    Serial.println("    SD_ENABLED true in env_monitor_v2.ino.");
  } else {
    Serial.println(">>> SOME TESTS FAILED  ✗");
    Serial.println("    Card initialized but file I/O failed — likely a");
    Serial.println("    flaky card, bad format, or unstable power/wiring.");
  }
  line();
}

void loop() {
  /* Nothing — test runs once in setup(). Press RESET to run again. */
}
