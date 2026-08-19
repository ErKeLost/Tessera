export type BackgroundModel = {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
};

export const BACKGROUND_MODEL: BackgroundModel = Object.freeze({
  id: "deepseek/deepseek-v4-pro-0813",
  name: "DeepSeek: DeepSeek V4 Pro 0813",
  contextLength: 1_048_576,
});
