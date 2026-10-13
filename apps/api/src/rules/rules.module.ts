import { Module } from '@nestjs/common';
import { PureRuleEngineModule } from './pure-rule-engine.module';
import { ExampleRuleSet } from './rules/example.rule';

/**
 * The **single registration surface** for platform rule sets (§6.2).
 *
 * What is registered here and nowhere else: the example set, whose only purpose is to be an example —
 * it never becomes business policy (§6.2). Everything else a consumer needs comes from
 * `PureRuleEngineModule`, which is imported and re-exported rather than duplicated, so the registry a
 * consumer sees is the registry the example set registers into.
 *
 * Importing this module is therefore the same as importing `PureRuleEngineModule`, plus the example
 * registration. A runtime that must not carry the example set imports the pure module directly (§6.2),
 * not this one.
 */
@Module({
  imports: [PureRuleEngineModule],
  providers: [ExampleRuleSet],
  exports: [PureRuleEngineModule],
})
export class RulesModule {}
