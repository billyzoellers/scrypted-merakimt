import axios, { AxiosRequestConfig } from 'axios'
import sdk, { Device, DeviceInformation, ScryptedDeviceBase, DeviceProvider, ScryptedDeviceType, Thermometer, HumiditySensor, Settings, Setting, ScryptedInterface, Refresh, TemperatureUnit, AirQuality, Battery, FloodSensor, BinarySensor, AirQualitySensor, PM25Sensor, VOCSensor} from '@scrypted/sdk';
const { deviceManager, log } = sdk;

class MerakiMT extends ScryptedDeviceBase implements Battery, HumiditySensor, Thermometer, FloodSensor, BinarySensor, AirQualitySensor, PM25Sensor, VOCSensor {
  device: any;
  provider: MerakiMTController;

  constructor(nativeId: string, provider: MerakiMTController) {
    super(nativeId);
    this.provider = provider;
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
                    // device.batteryPercentage = reading.battery.percentage;
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
                    if (reading.indoorAirQuality.score > 92)
                        device.airQuality = AirQuality.Excellent;
                    else if (reading.indoorAirQuality.score > 79)
                        device.airQuality = AirQuality.Good;
                    else if (reading.indoorAirQuality.score > 59)
                        device.airQuality = AirQuality.Fair;
                    else if (reading.indoorAirQuality.score > 39)
                        device.airQuality = AirQuality.Poor;
                    else if (reading.indoorAirQuality.score > 19)
                        device.airQuality = AirQuality.Inferior;
                    else
                        device.airQuality = AirQuality.Unknown;
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
    for (let dev of resp) {
        this.console.log(` Discovered ${dev.name} ${dev.serial} ${dev.mac} ${dev.model} ${dev.sensor.metrics}`)
    
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

        if (interfaces.length === 0) {
            this.console.log(" No interfaces matched.")
            continue;
        }

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
    }
    
    // Sync device list
    await deviceManager.onDevicesChanged({
        devices,
    });

    for (let device of devices) {
        let providerDevice = this.devices.get(device.nativeId);
        if (!providerDevice) {
            providerDevice = new MerakiMT(device.nativeId, this);
            this.devices.set(device.nativeId, providerDevice);
        }
    }

  }

  getDevice(nativeId: string) {
    return this.devices.get(nativeId);
  }

}

export default new MerakiMTController();