# Muttasil Live Dashboard

A local, phone-ready occupancy dashboard for the Arduino serial counter. The Node server reads the Arduino's `Count: N` lines at 9600 baud, broadcasts updates to connected browsers with Socket.IO, and serves the dashboard over your local Wi-Fi. No Replit or cloud account is needed.

## Start on Windows

1. Install Node.js 18 or later.
2. In this folder, open a terminal and run `npm install`.
3. Connect the Arduino over USB and run `npm start`.
4. On your computer, open `http://localhost:3000`.
5. On your phone, while connected to the same Wi-Fi, open the `http://...` phone address printed by the server.
6. Choose the Arduino's COM port and select **Connect Arduino**.

The serial monitor must be closed while the dashboard owns the Arduino port. The Arduino should emit one line per reading, for example `Count: 12`, at 9600 baud.

Use **Preview with demo data** to inspect the dashboard without an Arduino. Demo counts are clearly identified and are not sensor readings. Use **Adjust capacity** to change the occupancy limit.

If the Arduino USB cable is unplugged, the dashboard immediately clears the count to `0` and marks the data feed offline. This prevents an old reading from appearing as a live occupancy count.

## TFT Display Code and Wiring

The TFT code used in the Muttasil physical prototype is available in the mBlock project below:

**mBlock TFT Code:**
https://planet.mblock.cc/project/projectedit/8544133

The project contains the code for the TFT display, the Muttasil interface, and the touch-based occupancy counter.

### Wiring

The prototype uses an **Arduino Uno**, a **2.4-inch TFT display**, and an **e-textile/wire sensing system**.

The sensing system works using a wire connected to the sensing material. When a person touches the sensing material, the Arduino detects the change and updates the occupancy count.

* **Touch/e-textile signal wire → A5**
* The sensing material is connected to the touch input.
* The TFT is connected directly to the Arduino as the shield.
* **No 3V3 connection is used.**
* No extra disconnected wire is required.

The wiring shown here represents the actual technique used in the current Muttasil prototype.

## AI-Powered Traffic Prediction

Muttasil can also use the collected occupancy data to identify patterns in mosque traffic.

By analyzing previous occupancy readings and prayer-time patterns, the system can predict when a mosque is likely to become more crowded. This can help worshippers choose a less crowded mosque and can help with better planning.

For example, if historical data shows that a mosque usually becomes highly occupied around a particular prayer time, Muttasil can predict the expected traffic level before that period begins.

This makes Muttasil more than a simple people counter. It combines **live occupancy data, prayer information, navigation, and AI-based traffic prediction** to help make finding a suitable mosque easier.

## About the Wire-Based Sensing

The current prototype uses a simple physical wire/e-textile sensing technique. The sensing material is placed where a person can touch it, and the Arduino detects the electrical change caused by the interaction.

When the system detects a valid touch, the occupancy count is updated and displayed on the TFT. The count can also be sent to the local dashboard so the live occupancy can be viewed from a phone.

This is the sensing method used by the current prototype and does not require a camera.

## Phone Connection Tips

* Phone and computer need to be on the same Wi-Fi network.
* Use the network address printed by `npm start`, not `localhost`, on the phone.
* If the page will not load, allow Node.js through Windows Firewall on your private network.

## Palette

`#607744` · `#352208` · `#FDFFF7` · `#4F6D7A` · `#DDA448`
