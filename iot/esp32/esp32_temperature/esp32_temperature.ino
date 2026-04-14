#include <WiFi.h>
#include <SocketIOclient.h>
#include <ArduinoJson.h>
#include <DHT.h>

#define DHTPIN 4
#define DHTTYPE DHT11

DHT dht(DHTPIN, DHTTYPE);
SocketIOclient socketIO;

// WiFi
const char* ssid = "GREGORIO WIFI 2.4G";
const char* password = "REDACTED-ROTATED-WIFI-PASSWORD";

// Server
const char* host = "192.168.100.9";
const uint16_t port = 3000;

unsigned long lastSend = 0;

// Socket.IO events
void socketIOEvent(socketIOmessageType_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case sIOtype_DISCONNECT:
      Serial.println("[IO] Disconnected");
      break;
    case sIOtype_CONNECT:
      Serial.println("[IO] Connected");
      socketIO.send(sIOtype_CONNECT, "/");
      break;
    case sIOtype_EVENT:
      Serial.printf("[IO] Event: %s\n", payload);
      break;
  }
}

void setup() {
  Serial.begin(115200);
  dht.begin();

  WiFi.begin(ssid, password);
  Serial.print("Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected");
  Serial.println(WiFi.localIP());

  socketIO.begin(host, port, "/socket.io/?EIO=3");
  socketIO.onEvent(socketIOEvent);
  socketIO.setReconnectInterval(5000);
}

void loop() {
  socketIO.loop();

  if (millis() - lastSend > 3000) { // send every 3 sec
    lastSend = millis();

    float temperature = dht.readTemperature();
    float humidity = dht.readHumidity();

    if (isnan(temperature) || isnan(humidity)) {
      Serial.println("Failed to read from DHT");
      return;
    }

    // JSON payload
    StaticJsonDocument<200> doc;
    JsonArray array = doc.to<JsonArray>();
    array.add("sensorData");
    JsonObject param = array.createNestedObject();
    param["temperature"] = temperature;
    param["humidity"] = humidity;

    String output;
    serializeJson(doc, output);

    socketIO.sendEVENT(output);
    Serial.println("Sent: " + output);
  }
}
