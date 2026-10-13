import { Injectable, Logger } from '@nestjs/common';
import { IAIProvider } from './i-ai-provider';

@Injectable()
export class AzureOpenAIProvider implements IAIProvider {
  private logger = new Logger(AzureOpenAIProvider.name);

  constructor() {
    this.logger.log('AzureOpenAIProvider initialized (stub for Phase B implementation)');
  }

  async generateText(): Promise<string> {
    throw new Error('AzureOpenAIProvider not implemented in Phase A');
  }

  async generateEmbedding(): Promise<number[]> {
    throw new Error('AzureOpenAIProvider not implemented in Phase A');
  }

  /** Capability contract (§7). A stub has no vector-space contract to report. */
  getEmbeddingContract(): { model: string; dimension: number } {
    throw new Error('AzureOpenAIProvider not implemented in Phase A');
  }

  async generateCompletion(): Promise<string> {
    throw new Error('AzureOpenAIProvider not implemented in Phase A');
  }
}
