/* eslint-disable @typescript-eslint/no-require-imports -- committed debug utility; runs under plain node against ../dist and cannot use ESM imports. */
const { Test } = require('@nestjs/testing');
(async function(){
  try{
    const moduleFixture = await Test.createTestingModule({ imports: [require('../dist/app.module').AppModule] }).compile();
    const app = moduleFixture.createNestApplication();
    await app.init();
    console.log('Test app initialized');
    const adapter = app.getHttpAdapter();
    const instance = adapter.getInstance();
    if (instance && instance._router && instance._router.stack) {
      const routes = instance._router.stack
        .filter((r) => r.route)
        .map((r) => Object.keys(r.route.methods).map((m) => `${m.toUpperCase()} ${r.route.path}`))
        .flat();
      console.log('ROUTES_START');
      routes.forEach(r => console.log(r));
      console.log('ROUTES_END');
    } else {
      console.log('NO_ROUTER');
    }
    await app.close();
  } catch(err){
    console.error('ERR', err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();