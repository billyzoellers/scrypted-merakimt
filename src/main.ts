import axios, { AxiosRequestConfig } from 'axios'
import sdk, { Device, DeviceInformation, ScryptedDeviceBase, DeviceProvider, ScryptedDeviceType, Thermometer, HumiditySensor, Settings, Setting, ScryptedInterface, Refresh, TemperatureUnit, AirQuality, Battery, FloodSensor, BinarySensor, AirQualitySensor, PM25Sensor, VOCSensor} from '@scrypted/sdk';
const { deviceManager, log } = sdk;
const MQTT = require("async-mqtt");
import { AsyncMqttClient } from 'async-mqtt';

function iaqIndexToAirQuality(iaqIndex: number) {
  if (iaqIndex > 92)
    return AirQuality.Excellent;
  else if (iaqIndex > 79)
    return AirQuality.Good;
  else if (iaqIndex > 59)
    return AirQuality.Fair;
  else if (iaqIndex > 39)
    return AirQuality.Poor;
  else if (iaqIndex > 19)
    return AirQuality.Inferior;
  
  return AirQuality.Unknown;
}

class MerakiMT extends ScryptedDeviceBase implements Battery, HumiditySensor, Thermometer, FloodSensor, BinarySensor, AirQualitySensor, PM25Sensor, VOCSensor {
  device: any;
  provider: MerakiMTController;
  mac: string;
  mqtt: AsyncMqttClient;

  constructor(nativeId: string, provider: MerakiMTController, mac: string) {
    super(nativeId);
    this.provider = provider;
    this.mac = mac;

    this.mqtt = MQTT.connect(provider.storage.getItem("mqtt_broker") || "mqtt://localhost:1883", {
      clientId: `merakimt/${this.nativeId}`
    });

    this.mqtt.on("connect", async () => {
      this.console.log(`[${this.nativeId}] Starting MQTT`);
      this.mqtt.on('message', (topic, message) => {
        const metric = topic.split('/')[6];
        const json = JSON.parse(message.toString());
        this.console.log(`[${this.nativeId}] `, metric, json);

        switch (metric) {
          case "door":
            this.binaryState = json.open;
            break;
          case "batteryPercentage":
            this.batteryLevel = json.batteryPercentage;
            break;
          case "waterDetection":
            this.flooded = json.wet;
            break;
          case "temperature":
            this.temperature = json.celsius;
            break;
          case "humidity":
            this.humidity = json.humidity;
            break;
          case "iaqIndex":
            this.airQuality = iaqIndexToAirQuality(json.iaqIndex);
            break;
        }

        
      });

      await this.mqtt.subscribe(`meraki/v1/mt/${this.provider.storage.getItem("network_id")}/ble/${this.mac.toUpperCase()}/+`);
    });
  }

  setTemperatureUnit(temperatureUnit: TemperatureUnit): Promise<void> {
    throw new Error('Method not implemented.');
  }
}

class MerakiMTController extends ScryptedDeviceBase implements DeviceProvider, Settings, Refresh {
  devices = new Map<string, any>();

  constructor() {
    super()
    this.discoverDevices()
  }

  async getRefreshFrequency(): Promise<number> {
    return 60;
  }

  async refresh(refreshInterface: string, userInitiated: boolean): Promise<void> {
    const url = `organizations/${this.storage.getItem('org_id')}/sensor/readings/latest?networkIds[]=${this.storage.getItem('network_id')}`
    const resp = await this.req(url)

    for (let dev of resp) {
        const device: ScryptedDeviceBase = this.getDevice(dev.serial)
        if (!device)
            continue
        
        // Iterate through each reading
        for (let reading of dev.readings) {
            switch (reading.metric) {
                case "battery":
                    device.batteryLevel = reading.battery.percentage;
                    break;
                case "temperature":
                    device.temperature = reading.temperature.celsius;
                    break;
                case "humidity":
                    device.humidity = reading.humidity.relativePercentage;
                    break;
                case "water":
                    device.flooded = reading.water.present;
                    break;
                case "door":
                    device.binaryState = reading.door.open;
                    break;
                case "indoorAirQuality":
                    device.airQuality = iaqIndexToAirQuality(reading.indoorAirQuality.score);
                    break;
                case "tvoc":
                    device.vocDensity = reading.tvoc.concentration;
                    break;
                case "pm25":
                    device.pm25Density = reading.pm25.concentration;
                    break;
            }
        }
    }
  }

  async getSettings(): Promise<Setting[]> {
    return [
      {
        title: "Meraki API Key",
        key: "api_token",
        description: "Meraki access token",
        value: this.storage.getItem("api_token"),
      },
      {
        title: "Meraki Org ID",
        key: "org_id",
        description: "Meraki org ID",
        value: this.storage.getItem("org_id"),
      },
      {
        title: "Meraki Network ID",
        key: "network_id",
        description: "Meraki network ID",
        value: this.storage.getItem("network_id"),
      },
      {
        title: "MQTT Broker",
        key: "mqtt_broker",
        description: "MQTT Broker",
        value: this.storage.getItem("mqtt_broker") || "mqtt://localhost:1883",
      }
    ]
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value.toString());
  }


  // Generic API request
  async req(
    endpoint: string,
  ): Promise<any> {

    // Configure API request
    const config: AxiosRequestConfig = {
      method: "GET",
      baseURL: `https://api.meraki.com/api/v1/`,
      url: endpoint,
      headers: {
        'X-Cisco-Meraki-API-Key': this.storage.getItem('api_token'),
      },
      timeout: 10000,
    }

    return (await axios.request(config)).data;
  }

  async discoverDevices(): Promise<void> {
    // Get a list of devices
    const url = `organizations/${this.storage.getItem('org_id')}/devices?productTypes[]=sensor&networkIds[]=${this.storage.getItem('network_id')}`
    const resp = await this.req(url)

    const devices: Device[] = [];
    const deviceSNtoMAC = {};
    for (let dev of resp) {
        this.console.log(`[Meraki MT Plugin] Discovered ${dev.name} (${dev.model}) ${dev.mac} ${dev.sensor.metrics}`)
    
        const interfaces: ScryptedInterface[] = []

        // Discover interfaces
        if (dev.sensor.metrics.includes("temperature"))
            interfaces.push(ScryptedInterface.Thermometer);
        if (dev.sensor.metrics.includes("humidity"))
            interfaces.push(ScryptedInterface.HumiditySensor);
        if (dev.sensor.metrics.includes("water"))
            interfaces.push(ScryptedInterface.FloodSensor);
        if (dev.sensor.metrics.includes("door"))
            interfaces.push(ScryptedInterface.BinarySensor);
        if (dev.sensor.metrics.includes("indoorAirQuality"))
            interfaces.push(ScryptedInterface.AirQualitySensor);
        if (dev.sensor.metrics.includes("pm25"))
            interfaces.push(ScryptedInterface.PM25Sensor);
        if (dev.sensor.metrics.includes("tvoc"))
            interfaces.push(ScryptedInterface.VOCSensor);

        // Do not create devices if no interfaces are supported
        if (interfaces.length === 0) {
            this.console.log(`[Meraki MT Plugin] ${dev.serial} No interfaces matched.`)
            continue;
        }

        // All MT devices support Battery
        interfaces.push(ScryptedInterface.Battery);

        const info: DeviceInformation = {
            model: dev.model,
            manufacturer: "Cisco Meraki",
            serialNumber: dev.serial,
        }

        const device: Device = {
            nativeId: dev.serial,
            name: dev.name,
            type: ScryptedDeviceType.Sensor,
            info,
            interfaces,
        }

        devices.push(device)
        deviceSNtoMAC[dev.serial] = dev.mac;
    }
    
    // Sync device list
    await deviceManager.onDevicesChanged({
        devices,
    });

    for (let device of devices) {
        let providerDevice = this.devices.get(device.nativeId);
        if (!providerDevice) {
            providerDevice = new MerakiMT(device.nativeId, this, deviceSNtoMAC[device.nativeId]);
            this.devices.set(device.nativeId, providerDevice);
        }
    }

  }

  getDevice(nativeId: string) {
    return this.devices.get(nativeId);
  }

}

export default new MerakiMTController();