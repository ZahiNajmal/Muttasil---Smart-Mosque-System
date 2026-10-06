#include <Arduino.h>
/*
 * MUTTASIL - Touch Wire Counter (Unidirectional) - FAST v9
 * Touch A5 wire -> people enter (+1)
 *
 * mBlock-safe: only built-in types (unsigned char / unsigned int / unsigned long)
 * and macros are used, so mBlock moving prototypes to the top cannot break it.
 *
 * Wiring:
 *  TFT D0->8  D1->9  D2->2  D3->3  D4->4  D5->5  D6->6  D7->7
 *  TFT RD->A0 WR->A1 CD->A2 CS->A3 RST->A4     Touch -> A5
 *  TFT 5V->5V  GND->GND  3V3 -> leave disconnected
 */

#include <avr/io.h>

#define TFT_RD   A0
#define TFT_WR   A1
#define TFT_CD   A2
#define TFT_CS   A3
#define TFT_RST  A4
#define TOUCH_PIN A5

// ---- fast pin / bus macros (A0..A5 = PORTC bits 0..5) ----
#define WR_LOW   PORTC &= ~_BV(1)
#define WR_HIGH  PORTC |=  _BV(1)
#define CD_LOW   PORTC &= ~_BV(2)
#define CD_HIGH  PORTC |=  _BV(2)
#define CS_LOW   PORTC &= ~_BV(3)
#define CS_HIGH  PORTC |=  _BV(3)

#define WRITE_BUS(v) { PORTB = (PORTB & 0xFC) | ((v) & 0x03); PORTD = (PORTD & 0x03) | ((v) & 0xFC); }
#define PULSE_WR     { WR_LOW; WR_HIGH; }

// ---- serial (must match BAUD_RATE in the dashboard, default 9600) ----
#define SERIAL_BAUD 9600

// ---- screen orientation: 0x28 landscape. If mirrored/rotated try 0xE8, 0x48, 0x88 ----
#define MADCTL_VALUE 0x28

// ---- colors ----
#define BG_COLOR 0x0841
#define TEAL     0x03EF
#define CYAN     0x07FF
#define WHITE    0xFFFF
#define BLACK    0x0000
#define GREEN    0x07E0
#define RED      0xF800
#define ORANGE   0xFD20
#define YELLOW   0xFFE0
#define DGRAY    0x39E7
#define MGRAY    0x2104

// ---- settings ----
const int MAX_PEOPLE = 100;
// ---- touch settings (floating wire on A5, touch the bare metal with your finger) ----
// After upload the screen draws, waits ~1.5 s, then measures the idle level for 2 s.
// KEEP YOUR HAND OFF THE WIRE for the first ~4 seconds after power-up / connecting.
// A tap counts when you LIFT your finger (touch lasted at least MIN_TAP_MS).
//   Too sensitive?        raise TOUCH_DELTA (200, 300)
//   Not sensitive enough? lower TOUCH_DELTA (100, 70)
#define USE_PULLUP 0        // 0 = floating wire. If you wire the fabric to GND and A5 to a probe, use 1.
#define DEBUG_SCREEN 1      // shows V (reading) B (idle level) D (difference) on the screen; RED = touch seen
#define DEBUG_TOUCH 0       // 1 = also print readings to the serial monitor

const long TOUCH_DELTA = 150;
const unsigned long MIN_TAP_MS = 60;
const unsigned long MAX_TOUCH_MS = 3000;   // "touched" longer than this = drift, re-measure
const unsigned long RELEASE_HOLD_MS = 150;
const unsigned long debounceDelay = 500;
const unsigned long HEARTBEAT_MS = 1000;   // re-send Count so the dashboard stays in sync
const unsigned long SETTLE_MS = 1500;
const unsigned long CALIBRATE_MS = 2000;
const unsigned long GRACE_MS = 1500;

long baseline = 512;

unsigned long lastCountTime = 0;
unsigned long touchStart = 0;
unsigned long lastTouchedSeen = 0;
unsigned long graceUntil = 0;
unsigned long lastBeat = 0;
unsigned long lastAdapt = 0;
unsigned long lastDbg = 0;
bool touching = false;
int peopleCount = 0;

// ---- 7-segment patterns ----
const unsigned char SEGS[10] = {
  1 + 2 + 4 + 16 + 32 + 64,       // 0
  4 + 32,                         // 1
  1 + 4 + 8 + 16 + 64,            // 2
  1 + 4 + 8 + 32 + 64,            // 3
  2 + 4 + 8 + 32,                 // 4
  1 + 2 + 8 + 32 + 64,            // 5
  1 + 2 + 8 + 16 + 32 + 64,       // 6
  1 + 4 + 32,                     // 7
  1 + 2 + 4 + 8 + 16 + 32 + 64,   // 8
  1 + 2 + 4 + 8 + 32 + 64         // 9
};

// ---- font ----
const unsigned char FONT_5X7[][5] = {
  {0x00, 0x00, 0x00, 0x00, 0x00},  // SPACE
  {0x63, 0x13, 0x08, 0x64, 0x63},  // %
  {0x08, 0x08, 0x08, 0x08, 0x08},  // -
  {0x00, 0x60, 0x60, 0x00, 0x00},  // .
  {0x7E, 0x11, 0x11, 0x11, 0x7E},  // A
  {0x7F, 0x49, 0x49, 0x49, 0x36},  // B
  {0x3E, 0x41, 0x41, 0x41, 0x22},  // C
  {0x7F, 0x41, 0x41, 0x22, 0x1C},  // D
  {0x7F, 0x49, 0x49, 0x49, 0x41},  // E
  {0x7F, 0x09, 0x09, 0x09, 0x01},  // F
  {0x3E, 0x41, 0x49, 0x49, 0x7A},  // G
  {0x7F, 0x08, 0x08, 0x08, 0x7F},  // H
  {0x00, 0x41, 0x7F, 0x41, 0x00},  // I
  {0x20, 0x40, 0x41, 0x3F, 0x01},  // J
  {0x7F, 0x08, 0x14, 0x22, 0x41},  // K
  {0x7F, 0x40, 0x40, 0x40, 0x40},  // L
  {0x7F, 0x02, 0x0C, 0x02, 0x7F},  // M
  {0x7F, 0x04, 0x08, 0x10, 0x7F},  // N
  {0x3E, 0x41, 0x41, 0x41, 0x3E},  // O
  {0x7F, 0x09, 0x09, 0x09, 0x06},  // P
  {0x3E, 0x41, 0x51, 0x21, 0x5E},  // Q
  {0x7F, 0x09, 0x19, 0x29, 0x46},  // R
  {0x46, 0x49, 0x49, 0x49, 0x31},  // S
  {0x01, 0x01, 0x7F, 0x01, 0x01},  // T
  {0x3F, 0x40, 0x40, 0x40, 0x3F},  // U
  {0x1F, 0x20, 0x40, 0x20, 0x1F},  // V
  {0x7F, 0x20, 0x18, 0x20, 0x7F},  // W
  {0x63, 0x14, 0x08, 0x14, 0x63},  // X
  {0x07, 0x08, 0x70, 0x08, 0x07},  // Y
  {0x61, 0x51, 0x49, 0x45, 0x43},  // Z
  {0x3E, 0x51, 0x49, 0x45, 0x3E},  // 0
  {0x00, 0x42, 0x7F, 0x40, 0x00},  // 1
  {0x42, 0x61, 0x51, 0x49, 0x46},  // 2
  {0x21, 0x41, 0x45, 0x4B, 0x31},  // 3
  {0x18, 0x14, 0x12, 0x7F, 0x10},  // 4
  {0x27, 0x45, 0x45, 0x45, 0x39},  // 5
  {0x3C, 0x4A, 0x49, 0x49, 0x30},  // 6
  {0x01, 0x71, 0x09, 0x05, 0x03},  // 7
  {0x36, 0x49, 0x49, 0x49, 0x36},  // 8
  {0x06, 0x49, 0x49, 0x29, 0x1E}   // 9
};

// ============================================================
// LOW LEVEL TFT
// ============================================================
void writeCommand(unsigned char c) {
  CS_LOW; CD_LOW;
  WRITE_BUS(c); PULSE_WR;
  CS_HIGH;
}

void writeData(unsigned char d) {
  CS_LOW; CD_HIGH;
  WRITE_BUS(d); PULSE_WR;
  CS_HIGH;
}

void writeData16(unsigned int d) {
  CS_LOW; CD_HIGH;
  WRITE_BUS(d >> 8); PULSE_WR;
  WRITE_BUS(d & 0xFF); PULSE_WR;
  CS_HIGH;
}

void setAddressWindow(unsigned int x0, unsigned int y0, unsigned int x1, unsigned int y1) {
  writeCommand(0x2A);
  writeData16(x0);
  writeData16(x1);
  writeCommand(0x2B);
  writeData16(y0);
  writeData16(y1);
  writeCommand(0x2C);
}

void fillRect(int x, int y, int w, int h, unsigned int color) {
  if (w <= 0 || h <= 0) return;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > 320) w = 320 - x;
  if (y + h > 240) h = 240 - y;
  if (w <= 0 || h <= 0) return;

  setAddressWindow(x, y, x + w - 1, y + h - 1);
  CS_LOW; CD_HIGH;

  unsigned char hi = color >> 8;
  unsigned char lo = color & 0xFF;
  unsigned char baseB = PORTB & 0xFC;
  unsigned char baseD = PORTD & 0x03;
  unsigned char hiB = baseB | (hi & 0x03);
  unsigned char hiD = baseD | (hi & 0xFC);
  unsigned char loB = baseB | (lo & 0x03);
  unsigned char loD = baseD | (lo & 0xFC);
  unsigned long total = (unsigned long)w * h;

  if (hi == lo) {
    PORTB = hiB; PORTD = hiD;
    total *= 2;
    while (total--) { WR_LOW; WR_HIGH; }
  } else {
    while (total--) {
      PORTB = hiB; PORTD = hiD; WR_LOW; WR_HIGH;
      PORTB = loB; PORTD = loD; WR_LOW; WR_HIGH;
    }
  }
  CS_HIGH;
}

void drawRect(int x, int y, int w, int h, unsigned int color) {
  fillRect(x, y, w, 1, color);
  fillRect(x, y + h - 1, w, 1, color);
  fillRect(x, y, 1, h, color);
  fillRect(x + w - 1, y, 1, h, color);
}

void fillScreen(unsigned int color) {
  fillRect(0, 0, 320, 240, color);
}

// ============================================================
// TEXT
// ============================================================
int fontIndex(char c) {
  if (c == ' ') return 0;
  if (c == '%') return 1;
  if (c == '-') return 2;
  if (c == '.') return 3;
  if (c >= 'A' && c <= 'Z') return 4 + (c - 'A');
  if (c >= '0' && c <= '9') return 30 + (c - '0');
  return 0;
}

// One address window per character; paints its own background.
void drawChar(int x, int y, char c, unsigned int color, unsigned int bg, int scale) {
  int idx = fontIndex(c);
  int w = 6 * scale;
  int h = 7 * scale;
  if (x < 0 || y < 0 || x + w > 320 || y + h > 240) return;

  setAddressWindow(x, y, x + w - 1, y + h - 1);
  CS_LOW; CD_HIGH;

  for (int row = 0; row < 7; row++) {
    for (int sy = 0; sy < scale; sy++) {
      for (int col = 0; col < 6; col++) {
        unsigned int px = bg;
        if (col < 5 && (FONT_5X7[idx][col] & (1 << row))) px = color;
        unsigned char hi = px >> 8;
        unsigned char lo = px & 0xFF;
        for (int sx = 0; sx < scale; sx++) {
          WRITE_BUS(hi); WR_LOW; WR_HIGH;
          WRITE_BUS(lo); WR_LOW; WR_HIGH;
        }
      }
    }
  }
  CS_HIGH;
}

void drawText(int x, int y, const char *text, unsigned int color, unsigned int bg, int scale) {
  while (*text) {
    drawChar(x, y, *text, color, bg, scale);
    x += 6 * scale;
    text++;
  }
}

// ============================================================
// 7-SEGMENT NUMBER (redraws only changed segments)
// ============================================================
void drawDigit(int x, int y, unsigned char d, unsigned int fg, unsigned int bg, unsigned char mask) {
  const int W = 50, H = 80, T = 10, G = 3;
  unsigned char s = SEGS[d];

  if (mask & 1)  fillRect(x + G + T,     y + G,             W - 2 * T, T,         (s & 1)  ? fg : bg);
  if (mask & 2)  fillRect(x + G,         y + G + T,         T, H / 2 - T - G,     (s & 2)  ? fg : bg);
  if (mask & 4)  fillRect(x + G + W - T, y + G + T,         T, H / 2 - T - G,     (s & 4)  ? fg : bg);
  if (mask & 8)  fillRect(x + G + T,     y + G + H / 2 - G, W - 2 * T, T,         (s & 8)  ? fg : bg);
  if (mask & 16) fillRect(x + G,         y + G + H / 2 + G, T, H / 2 - T - G,     (s & 16) ? fg : bg);
  if (mask & 32) fillRect(x + G + W - T, y + G + H / 2 + G, T, H / 2 - T - G,     (s & 32) ? fg : bg);
  if (mask & 64) fillRect(x + G + T,     y + G + H - T,     W - 2 * T, T,         (s & 64) ? fg : bg);
}

void drawNumber(int x, int y, int num, unsigned int fg, unsigned int bg) {
  static signed char prev[3] = {-1, -1, -1};
  static unsigned int prevFg = 0;
  static int prevX = -1;

  int digs = 1;
  if (num >= 100) digs = 3;
  else if (num >= 10) digs = 2;

  signed char d[3] = {-1, -1, -1};
  if (digs == 3) d[0] = num / 100;
  if (digs >= 2) d[1] = (num / 10) % 10;
  d[2] = num % 10;

  if (x != prevX) {                 // digit count changed: clear and redraw all
    fillRect(0, y, 168, 88, bg);
    prev[0] = -1; prev[1] = -1; prev[2] = -1;
    prevX = x;
  }

  for (int i = 0; i < 3; i++) {
    if (d[i] < 0) continue;
    int dx = x + 62 * (i - (3 - digs));
    unsigned char mask;
    if (prev[i] < 0 || fg != prevFg) mask = 0x7F;
    else mask = SEGS[(int)prev[i]] ^ SEGS[(int)d[i]];
    if (mask) drawDigit(dx, y, d[i], fg, bg, mask);
    prev[i] = d[i];
  }
  prevFg = fg;
}

// ============================================================
// STATIC UI (once)
// ============================================================
void drawStaticUI() {
  fillScreen(BG_COLOR);

  fillRect(0, 0, 320, 42, TEAL);
  fillRect(0, 42, 320, 3, CYAN);
  drawText(8, 9, "MUTTASIL", WHITE, TEAL, 3);

  fillRect(220, 12, 12, 12, GREEN);
  fillRect(236, 12, 12, 12, GREEN);
  fillRect(252, 12, 12, 12, GREEN);

  fillRect(0, 45, 320, 20, MGRAY);
  drawText(10, 50, "PEOPLE INSIDE:", CYAN, MGRAY, 2);

  fillRect(168, 45, 3, 192, DGRAY);

  drawText(180, 106, "OCCUPANCY", DGRAY, BG_COLOR, 1);
  fillRect(175, 120, 136, 18, MGRAY);
  drawRect(175, 120, 136, 18, DGRAY);

  fillRect(0, 200, 320, 3, DGRAY);
  fillRect(0, 203, 320, 37, 0x0010);

  int mx = 20;
  fillRect(mx + 10, 215, 40, 20, 0x0820);
  fillRect(mx + 15, 207, 30, 8, 0x0820);
  fillRect(mx + 20, 203, 20, 4, 0x0820);
  fillRect(mx + 27, 200, 6, 3, YELLOW);
  fillRect(mx + 15, 222, 10, 13, BG_COLOR);
  fillRect(mx + 35, 222, 10, 13, BG_COLOR);
  fillRect(mx + 22, 218, 16, 17, 0x0010);

  drawText(80, 210, "MUTTASIL  -  LIVE OCCUPANCY", DGRAY, 0x0010, 1);
  drawText(90, 222, "Smart Mosque Management", DGRAY, 0x0010, 1);

  fillRect(0, 234, 320, 6, TEAL);
  for (int i = 0; i < 8; i++) {
    fillRect(8 + i * 38, 235, 28, 4, 0x025F);
  }
}

// ============================================================
// DYNAMIC UI
// ============================================================
void updateUI(int count) {
  unsigned int nc = GREEN;
  if (count > 80)      nc = RED;
  else if (count > 50) nc = ORANGE;
  else if (count > 20) nc = YELLOW;

  int digits = 1;
  if (count >= 100) digits = 3;
  else if (count >= 10) digits = 2;
  int sx = (160 - digits * 62) / 2;
  if (sx < 4) sx = 4;
  drawNumber(sx, 68, count, nc, BG_COLOR);

  int pct = constrain(map(count, 0, MAX_PEOPLE, 0, 100), 0, 100);

  static int lastPct = -1;
  static unsigned int lastCol = 0;

  if (pct != lastPct || nc != lastCol) {
    char pctText[5];
    pctText[0] = ' '; pctText[1] = ' '; pctText[2] = ' '; pctText[3] = ' '; pctText[4] = 0;
    if (pct == 100) {
      pctText[0] = '1'; pctText[1] = '0'; pctText[2] = '0'; pctText[3] = '%';
    } else if (pct >= 10) {
      pctText[0] = '0' + pct / 10; pctText[1] = '0' + pct % 10; pctText[2] = '%';
    } else {
      pctText[0] = '0' + pct; pctText[1] = '%';
    }
    drawText(180, 145, pctText, nc, BG_COLOR, 3);

    int fillW = (134 * pct) / 100;
    if (fillW > 0)   fillRect(176, 121, fillW, 16, nc);
    if (fillW < 134) fillRect(176 + fillW, 121, 134 - fillW, 16, MGRAY);

    lastPct = pct;
    lastCol = nc;
  }
}

// ============================================================
// TFT INIT (standard ILI9341)
// ============================================================
void initTFT() {
  digitalWrite(TFT_CS, HIGH);
  digitalWrite(TFT_WR, HIGH);
  digitalWrite(TFT_RD, HIGH);
  digitalWrite(TFT_CD, HIGH);

  digitalWrite(TFT_RST, HIGH); delay(5);
  digitalWrite(TFT_RST, LOW);  delay(20);
  digitalWrite(TFT_RST, HIGH); delay(150);

  writeCommand(0x01); delay(150);

  writeCommand(0xCF); writeData(0x00); writeData(0xC1); writeData(0x30);
  writeCommand(0xED); writeData(0x64); writeData(0x03); writeData(0x12); writeData(0x81);
  writeCommand(0xE8); writeData(0x85); writeData(0x00); writeData(0x78);
  writeCommand(0xCB); writeData(0x39); writeData(0x2C); writeData(0x00); writeData(0x34); writeData(0x02);
  writeCommand(0xF7); writeData(0x20);
  writeCommand(0xEA); writeData(0x00); writeData(0x00);
  writeCommand(0xC0); writeData(0x23);
  writeCommand(0xC1); writeData(0x10);
  writeCommand(0xC5); writeData(0x3E); writeData(0x28);
  writeCommand(0xC7); writeData(0x86);
  writeCommand(0x36); writeData(MADCTL_VALUE);
  writeCommand(0x3A); writeData(0x55);
  writeCommand(0xB1); writeData(0x00); writeData(0x18);
  writeCommand(0xB6); writeData(0x08); writeData(0x82); writeData(0x27);
  writeCommand(0xF2); writeData(0x00);
  writeCommand(0x26); writeData(0x01);

  writeCommand(0xE0);
  writeData(0x0F); writeData(0x31); writeData(0x2B); writeData(0x0C); writeData(0x0E);
  writeData(0x08); writeData(0x4E); writeData(0xF1); writeData(0x37); writeData(0x07);
  writeData(0x10); writeData(0x03); writeData(0x0E); writeData(0x09); writeData(0x00);

  writeCommand(0xE1);
  writeData(0x00); writeData(0x0E); writeData(0x14); writeData(0x03); writeData(0x11);
  writeData(0x07); writeData(0x31); writeData(0xC1); writeData(0x48); writeData(0x08);
  writeData(0x0F); writeData(0x0C); writeData(0x31); writeData(0x36); writeData(0x0F);

  writeCommand(0x11); delay(150);
  writeCommand(0x29); delay(30);
}

// ============================================================
// SETUP
// ============================================================
void setup() {
  Serial.begin(SERIAL_BAUD);

  for (int p = 2; p <= 9; p++) pinMode(p, OUTPUT);
  pinMode(TFT_RD, OUTPUT);
  pinMode(TFT_WR, OUTPUT);
  pinMode(TFT_CD, OUTPUT);
  pinMode(TFT_CS, OUTPUT);
  pinMode(TFT_RST, OUTPUT);
#if USE_PULLUP
  pinMode(TOUCH_PIN, INPUT_PULLUP);
#else
  pinMode(TOUCH_PIN, INPUT);
#endif

  Serial.println("Count: 0");

  initTFT();
  drawStaticUI();
  updateUI(peopleCount);
  delay(SETTLE_MS);          // let the wire settle after all the screen drawing
  calibrate();
  lastBeat = millis();
  graceUntil = millis() + GRACE_MS;
}

// ============================================================
// LOOP
// ============================================================
int readTouch() {
  analogRead(TOUCH_PIN);                 // dummy read: lets the ADC settle on a floating pin
  long sum = 0;
  for (int i = 0; i < 4; i++) sum += analogRead(TOUCH_PIN);
  return (int)(sum / 4);
}

void calibrate() {
  unsigned long t = millis();
  long sum = 0;
  long n = 0;
  while (millis() - t < CALIBRATE_MS) {
    sum += readTouch();
    n++;
    delay(5);
  }
  if (n > 0) baseline = sum / n;
  Serial.print("Baseline: ");
  Serial.println(baseline);
}

void sendCount() {
  Serial.print("Count: ");
  Serial.println(peopleCount);
}

// writes a number right-aligned into 4 characters of buf
void putNum(char *b, int pos, long v) {
  if (v < 0) v = 0;
  if (v > 9999) v = 9999;
  b[pos]     = (v >= 1000) ? ('0' + v / 1000) : ' ';
  b[pos + 1] = (v >= 100)  ? ('0' + (v / 100) % 10) : ' ';
  b[pos + 2] = (v >= 10)   ? ('0' + (v / 10) % 10) : ' ';
  b[pos + 3] = '0' + v % 10;
}

void drawDebug(long v, long dev, bool t) {
  char b[18] = "V0000 B0000 D0000";
  putNum(b, 1, v);
  putNum(b, 7, baseline);
  putNum(b, 13, dev);
  drawText(176, 176, b, t ? RED : CYAN, BG_COLOR, 1);
}

void loop() {
  int v = readTouch();
  unsigned long now = millis();

  long dev = (long)v - baseline;
  if (dev < 0) dev = -dev;
  bool touchedNow = (dev > TOUCH_DELTA);

  if (!touching) {
    if (touchedNow && now > graceUntil) {
      touching = true;
      touchStart = now;
      lastTouchedSeen = now;
    }
  } else {
    if (touchedNow) {
      lastTouchedSeen = now;
      if (now - touchStart > MAX_TOUCH_MS) {     // far too long = drift, not a person
        touching = false;
        calibrate();
        graceUntil = millis() + GRACE_MS;
      }
    } else if (now - lastTouchedSeen >= RELEASE_HOLD_MS) {
      unsigned long dur = lastTouchedSeen - touchStart;
      touching = false;
      if (dur >= MIN_TAP_MS && now - lastCountTime >= debounceDelay) {
        lastCountTime = now;
        if (peopleCount < 999) peopleCount++;
        sendCount();                 // send first
        lastBeat = now;
        updateUI(peopleCount);       // draw after
      }
    }
  }

  // slowly follow idle drift whenever the wire is not being touched
  if (!touchedNow && now - lastAdapt >= 200) {
    lastAdapt = now;
    baseline += ((long)v - baseline) / 16;
  }

  if (now - lastBeat >= HEARTBEAT_MS) {
    lastBeat = now;
    sendCount();
#if DEBUG_TOUCH
    Serial.print("Touch raw: ");
    Serial.print(v);
    Serial.print("  base: ");
    Serial.print(baseline);
    Serial.print("  diff: ");
    Serial.println(dev);
#endif
  }

#if DEBUG_SCREEN
  if (now - lastDbg >= 250) {
    lastDbg = now;
    drawDebug(v, dev, touchedNow);
  }
#endif
}
