export type ForecastModelName = 'rolling_dirichlet' | 'exponential_decay' | 'markov_shrinkage';

export interface ForecastModelScore {
  model: ForecastModelName;
  observations: number;
  meanLogLoss: number | null;
  meanBrierScore: number | null;
}

export interface ForecastSelection {
  model: ForecastModelName;
  probabilities: number[];
  validationObservations: number;
  selectedMeanLogLoss: number;
  scores: ForecastModelScore[];
}

export function selectForecastModel(
  digits: number[],
  windowSize: number,
  validationTicks?: number
): ForecastSelection | null;
