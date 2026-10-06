# Muttasil Live Dashboard

A local, phone-ready occupancy dashboard for the Arduino serial counter. The Node server reads the Arduino's `Count: N` lines at 9600 baud, broadcasts updates to connected browsers with Socket.IO, and serves the dashboard over your local Wi-Fi. No Replit or cloud account is needed.

## Start on Windows

1. Install Node.js 18 or later.
2. In this folder, open a terminal and run `npm install`.
3. Connect the Arduino over USB and run `npm start`.
4. On your computer, open `http://localhost:3000`.
5. On your phone, while connected to the same Wi-Fi, open the `http://...` phone address printed by the server.
6. Choose the Arduino's COM port and select **Connect Arduino**.

The serial monitor must be closed while the dashboard owns the Arduino port. The Arduino should emit one line per reading, for example `Count: 12`, at 9600 baud. The server can listen on a different baud rate with `BAUD_RATE=...` if the sketch is changed.

Use **Preview with demo data** to inspect the dashboard without an Arduino. Demo counts are clearly identified and are not sensor readings. Use **Adjust capacity** to change the occupancy limit.

If the Arduino USB cable is unplugged, the dashboard immediately clears the count to `0` and marks the data feed offline. That prevents an old reading from appearing as a live occupancy count.

## Phone connection tips

- Phone and computer need to be on the same Wi-Fi network.
- Use the network address printed by `npm start`, not `localhost`, on the phone.
- If the page will not load, allow Node.js through Windows Firewall on your private network.

## About wireless sensing

The current fabric/touch-wire input cannot detect someone at a distance: it needs a physical electrical connection and contact/coupling to change the input. Wireless reporting can be added between a sensor and the server, but the sensing method itself must still detect people. Practical prototype options include a doorway pair of break-beam IR sensors for directional entry/exit counting, a pressure mat/load sensor at a controlled entrance, or a privacy-conscious overhead depth sensor. A single PIR sensor detects motion/presence but does not reliably count entries and exits. Camera-based counting can work, but needs careful placement, lighting and privacy safeguards.

## Running without the Arduino USB cable

The blue USB cable currently supplies **both power and the data connection** between the Uno and the laptop. To remove it, power the Arduino from a suitable USB power bank or regulated 5 V supply, then give it a wireless data link:

- **Best option for a new build:** replace the Uno with an ESP32. It can read the fabric/touch sensor and send readings over Wi-Fi to the dashboard.
- **Keep the Uno:** add an ESP8266 Wi-Fi module or a Bluetooth module. Wi-Fi is the better fit for this dashboard because it can send the count to the laptop over the same local network.

The laptop must still be powered and connected to the same Wi-Fi if it is hosting the dashboard. An ESP8266 requires correct 3.3 V power and logic-level wiring; do not connect Uno 5 V signals directly to it.

## Palette

`#607744` · `#352208` · `#FDFFF7` · `#4F6D7A` · `#DDA448`
