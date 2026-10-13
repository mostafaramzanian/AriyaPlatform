const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/app.module');

async function run() {
  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleFixture.createNestApplication();
  await app.init();
  console.log('App initialized for route debug (dist)');
  try {
    const adapter = app.getHttpAdapter();
    const instance = adapter.getInstance();
    console.log('Adapter instance keys:', Object.getOwnPropertyNames(instance || {}));
    if (instance && instance._router && instance._router.stack) {
      const routes = instance._router.stack
        .filter((r) => r.route)
        .map((r) => Object.keys(r.route.methods).map((m) => `${m.toUpperCase()} ${r.route.path}`))
        .flat();
      console.log('+++ Registered routes start +++');
      routes.forEach((p) => console.log(p));
      console.log('+++ Registered routes end +++');
    } else if (instance && instance.router && instance.router.stack) {
      const routes = instance.router.stack
        .filter((r) => r.route)
        .map((r) => Object.keys(r.route.methods).map((m) => `${m.toUpperCase()} ${r.route.path}`))
        .flat();
      console.log('+++ Registered routes (alt) start +++');
      routes.forEach((p) => console.log(p));
      console.log('+++ Registered routes (alt) end +++');
    } else {
      console.log('No router stack found on adapter instance');
    }
  } catch (err) {
    console.error('Route debug failed', err);
  }

  await app.close();
}

run().catch((err) => console.error('Fatal', err));