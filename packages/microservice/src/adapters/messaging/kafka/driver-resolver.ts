import { KafkaDriver, KafkaAdapterConfig, KafkaDriverAdapter, KafkaDriverModule } from './types.js';

export interface ResolvedDriver {
  driver: KafkaDriver;
  module: KafkaDriverModule;
}

export async function resolveKafkaDriver(config: KafkaAdapterConfig): Promise<ResolvedDriver> {
  const requestedDriver = config.driver ?? 'auto';

  if (requestedDriver === 'oneunit') {
    return await loadOneUnitDriver();
  }

  if (requestedDriver === 'kafkajs') {
    return await loadKafkaJSDriver();
  }

  // Auto mode: try oneunit first, then kafkajs
  try {
    return await loadOneUnitDriver();
  } catch (oneUnitError) {
    try {
      return await loadKafkaJSDriver();
    } catch (kafkaJSError) {
      const oneUnitMsg = oneUnitError instanceof Error ? oneUnitError.message : String(oneUnitError);
      const kafkaJSMsg = kafkaJSError instanceof Error ? kafkaJSError.message : String(kafkaJSError);
      throw new Error(
        `No Kafka driver available. @oneunit/kafka: ${oneUnitMsg}. kafkajs: ${kafkaJSMsg}`,
      );
    }
  }
}

async function loadOneUnitDriver(): Promise<ResolvedDriver> {
  let oneUnitModule: any;
  try {
    oneUnitModule = await import('@oneunit/kafka');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Cannot find module') ||
      msg.includes('Failed to load url') ||
      msg.includes('Cannot find package')
    ) {
      throw new Error('@oneunit/kafka is not installed. Install it or use driver: "kafkajs"');
    }
    throw err;
  }

  // Verify the module has the expected exports
  if (!oneUnitModule.createKafkaClient && !oneUnitModule.KafkaClient) {
    throw new Error('@oneunit/kafka does not export required APIs (createKafkaClient, KafkaClient)');
  }

  const { createKafkaAdapter } = await import('./oneunit/adapter.js');

  return {
    driver: 'oneunit',
    module: {
      createAdapter: (cfg) => createKafkaAdapter(cfg, oneUnitModule),
    },
  };
}

async function loadKafkaJSDriver(): Promise<ResolvedDriver> {
  let kafkajsModule: any;
  try {
    kafkajsModule = await import('kafkajs');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Cannot find module') ||
      msg.includes('Failed to load url') ||
      msg.includes('Cannot find package')
    ) {
      throw new Error('kafkajs is not installed. Install it or use driver: "oneunit"');
    }
    throw err;
  }

  if (!kafkajsModule.Kafka) {
    throw new Error('kafkajs does not export Kafka class');
  }

  const { createKafkaAdapter } = await import('./kafkajs/adapter.js');

  return {
    driver: 'kafkajs',
    module: {
      createAdapter: (cfg) => createKafkaAdapter(cfg),
    },
  };
}