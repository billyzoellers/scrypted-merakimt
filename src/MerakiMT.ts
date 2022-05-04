// eslint-disable-next-line import/no-extraneous-dependencies
import {
  ScryptedDeviceBase,
  Thermometer,
  HumiditySensor,
  TemperatureUnit,
  Battery,
  FloodSensor,
  BinarySensor,
  AirQualitySensor,
  PM25Sensor,
  VOCSensor,
  AirQuality,
} from '@scrypted/sdk';
import { AsyncMqttClient } from 'async-mqtt';
// eslint-disable-next-line import/no-unresolved, import/extensions
import { MerakiMTController } from './MerakiMTController';

const MQTT = require('async-mqtt');

function iaqIndexToAirQuality(iaqIndex: number) {
  if (iaqIndex > 92) return AirQuality.Excellent;
  if (iaqIndex > 79) return AirQuality.Good;
  if (iaqIndex > 59) return AirQuality.Fair;
  if (iaqIndex > 39) return AirQuality.Poor;
  if (iaqIndex > 19) return AirQuality.Inferior;

  return AirQuality.Unknown;
}

export default class MerakiMT extends ScryptedDeviceBase
  implements Battery, HumiditySensor, Thermometer, FloodSensor, BinarySensor,
  AirQualitySensor, PM25Sensor, VOCSensor {
  device: any;

  provider: MerakiMTController;

  mac: string;

  mqtt: AsyncMqttClient;

  constructor(nativeId: string, provider: MerakiMTController, mac: string) {
    super(nativeId);
    this.provider = provider;
    this.mac = mac;

    this.mqtt = MQTT.connect(provider.storage.getItem('mqtt_broker') || 'mqtt://localhost:1883', {
      clientId: `merakimt/${this.nativeId}`,
    });

    this.mqtt.on('connect', async () => {
      this.console.log(`[${this.nativeId}] MQTT started`);
      this.mqtt.on('message', (topic, message) => {
        const metric = topic.split('/')[6];
        const json = JSON.parse(message.toString());
        this.console.log(`[${this.nativeId}] MQTT:`, metric, json);

        switch (metric) {
          case 'door':
            this.binaryState = json.open;
            break;
          case 'batteryPercentage':
            this.batteryLevel = json.batteryPercentage;
            break;
          case 'waterDetection':
            this.flooded = json.wet;
            break;
          case 'temperature':
            this.temperature = json.celsius;
            break;
          case 'humidity':
            this.humidity = json.humidity;
            break;
          case 'iaqIndex':
            this.airQuality = iaqIndexToAirQuality(json.iaqIndex);
            break;
          default:
            break;
        }
      });

      await this.mqtt.subscribe(`meraki/v1/mt/${this.provider.storage.getItem('network_id')}/ble/${this.mac.toUpperCase()}/+`);
    });
  }

  setTemperatureUnit(temperatureUnit: TemperatureUnit): Promise<void> {
    throw new Error(`[${this.nativeId}]: setTemperatureUnit ${temperatureUnit}. Not implemented.`);
  }
}
