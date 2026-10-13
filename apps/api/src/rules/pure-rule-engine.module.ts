import { Module } from '@nestjs/common';
import { RuleEngineService } from './rule-engine.service';
import { RuleRegistryService } from './rule-registry.service';

/**
 * The engine as a **dependency-free provider module** (§6.2).
 *
 * Why this module exists: `RulesModule` is the platform's registration surface, and it registers the
 * example set — so a runtime that must not instantiate example or legacy rule sets (the HR runtime,
 * whose policy is its own versioned data, §6.1) cannot import it. That runtime imports *this* module
 * instead and gets the same engine over its own registered versions.
 *
 * Why this is a module and not a second engine: it provides the **same** `RuleEngineService` and the
 * **same** `RuleRegistryService` classes. Introducing a second engine class is not permitted (§6.2,
 * §7); narrowing what is registered is.
 *
 * Why it is a plain static module rather than a dynamic one: Nest instantiates a module class once
 * per application, so every importer — `RulesModule` today, the HR runtime next — shares one registry
 * and therefore one view of which versions are published. A `register(...)` factory would give each
 * importer its own instance and silently split the store in two.
 */
@Module({
  providers: [RuleRegistryService, RuleEngineService],
  exports: [RuleRegistryService, RuleEngineService],
})
export class PureRuleEngineModule {}
