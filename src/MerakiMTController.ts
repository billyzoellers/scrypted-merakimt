import axios, { AxiosRequestConfig } from 'axios';
// eslint-disable-next-line import/no-extraneous-dependencies
import sdk, {
  Device,
  DeviceInformation,
  ScryptedDeviceBase,
  DeviceProvider,
  ScryptedDeviceType,
  Settings,
  Setting,
  ScryptedInterface,
  Refresh,
  AirQuality,
} from '@scrypted/sdk';
// eslint-disable-next-line import/no-unresolved, import/extensions
import MerakiMT from './MerakiMT';

const { deviceManager } = sdk;

export function iaqIndexToAirQuality(iaqIndex: number) {
  if (iaqIndex > 92) return AirQuality.Excellent;
  if (iaqIndex > 79) return AirQuality.Good;
  if (iaqIndex > 59) return AirQuality.Fair;
  if (iaqIndex > 39) return AirQuality.Poor;
  if (iaqIndex > 19) return AirQuality.Inferior;

  return AirQuality.Unknown;
}

export class MerakiMTController extends ScryptedDeviceBase
  implements DeviceProvider, Settings, Refresh {
  devices = new Map<string, any>();

  constructor() {
    super();
    this.discoverDevices();
  }

  // eslint-disable-next-line class-methods-use-this
  async getRefreshFrequency(): Promise<number> {
    return 60;
  }

  // eslint-disable-next-line no-unused-vars
  async refresh(refreshInterface: string, userInitiated: boolean): Promise<void> {
    const url = `organizations/${this.storage.getItem('org_id')}/sensor/readings/latest?networkIds[]=${this.storage.getItem('network_id')}`;
    const resp = await this.req(url);

    resp.forEach((dev) => {
      const device: ScryptedDeviceBase = this.getDevice(dev.serial);

      // Ignore non-existant devices
      if (!device) return;

      // Iterate through each reading
      dev.readings.forEach((reading) => {
        device.console.log(`[${device.nativeId}] API:`, reading.metric, reading);

        switch (reading.metric) {
          case 'battery':
            device.batteryLevel = reading.battery.percentage;
            break;
          case 'temperature':
            device.temperature = reading.temperature.celsius;
            break;
          case 'humidity':
            device.humidity = reading.humidity.relativePercentage;
            break;
          case 'water':
            device.flooded = reading.water.present;
            break;
          case 'door':
            device.binaryState = reading.door.open;
            break;
          case 'indoorAirQuality':
            device.airQuality = iaqIndexToAirQuality(reading.indoorAirQuality.score);
            break;
          case 'tvoc':
            device.vocDensity = reading.tvoc.concentration;
            break;
          case 'pm25':
            device.pm25Density = reading.pm25.concentration;
            break;
          default:
            break;
        }
      });
    });
  }

  async getSettings(): Promise<Setting[]> {
    return [
      {
        title: 'Meraki API Key',
        key: 'api_token',
        description: 'Meraki access token',
        value: this.storage.getItem('api_token'),
      },
      {
        title: 'Meraki Org ID',
        key: 'org_id',
        description: 'Meraki org ID',
        value: this.storage.getItem('org_id'),
      },
      {
        title: 'Meraki Network ID',
        key: 'network_id',
        description: 'Meraki network ID',
        value: this.storage.getItem('network_id'),
      },
      {
        title: 'MQTT Broker',
        key: 'mqtt_broker',
        description: 'MQTT Broker',
        value: this.storage.getItem('mqtt_broker') || 'mqtt://localhost:1883',
      },
    ];
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
      method: 'GET',
      baseURL: 'https://api.meraki.com/api/v1/',
      url: endpoint,
      headers: {
        'X-Cisco-Meraki-API-Key': this.storage.getItem('api_token'),
      },
      timeout: 10000,
    };

    return (await axios.request(config)).data;
  }

  async discoverDevices(): Promise<void> {
    // Get a list of devices
    const url = `organizations/${this.storage.getItem('org_id')}/devices?productTypes[]=sensor&networkIds[]=${this.storage.getItem('network_id')}`;
    const resp = await this.req(url);

    const devices: Device[] = [];
    const deviceSNtoMAC = {};

    resp.forEach((dev) => {
      this.console.log(`[Meraki MT Plugin] Discovered ${dev.name} (${dev.model}) ${dev.mac} ${dev.sensor.metrics}`);

      const interfaces: ScryptedInterface[] = [];

      // Discover interfaces
      if (dev.sensor.metrics.includes('temperature')) interfaces.push(ScryptedInterface.Thermometer);
      if (dev.sensor.metrics.includes('humidity')) interfaces.push(ScryptedInterface.HumiditySensor);
      if (dev.sensor.metrics.includes('water')) interfaces.push(ScryptedInterface.FloodSensor);
      if (dev.sensor.metrics.includes('door')) interfaces.push(ScryptedInterface.BinarySensor);
      if (dev.sensor.metrics.includes('indoorAirQuality')) interfaces.push(ScryptedInterface.AirQualitySensor);
      if (dev.sensor.metrics.includes('pm25')) interfaces.push(ScryptedInterface.PM25Sensor);
      if (dev.sensor.metrics.includes('tvoc')) interfaces.push(ScryptedInterface.VOCSensor);

      // Do not create devices if no interfaces are supported
      if (interfaces.length === 0) {
        this.console.log(`[Meraki MT Plugin] ${dev.serial} No interfaces matched.`);
        return;
      }

      // All MT devices support Battery
      interfaces.push(ScryptedInterface.Battery);

      const info: DeviceInformation = {
        model: dev.model,
        manufacturer: 'Cisco Meraki',
        serialNumber: dev.serial,
      };

      const device: Device = {
        nativeId: dev.serial,
        name: dev.name,
        type: ScryptedDeviceType.Sensor,
        info,
        interfaces,
      };

      devices.push(device);
      deviceSNtoMAC[dev.serial] = dev.mac;
    });

    // Sync device list
    await deviceManager.onDevicesChanged({
      devices,
    });

    devices.forEach((device) => {
      let providerDevice = this.devices.get(device.nativeId);
      if (!providerDevice) {
        providerDevice = new MerakiMT(device.nativeId, this, deviceSNtoMAC[device.nativeId]);
        this.devices.set(device.nativeId, providerDevice);
      }
    });
  }

  getDevice(nativeId: string) {
    return this.devices.get(nativeId);
  }
}
