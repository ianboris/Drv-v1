export type DigitStrategy = 'DIFFERS' | 'MATCHES' | 'EVEN' | 'ODD';

export function createDigitProposalRequest(input: {
  strategy: DigitStrategy;
  symbol: string;
  amount: number;
  currency: string;
  targetDigit: number;
  reqId: number;
}): {
  proposal: 1;
  amount: number;
  basis: 'stake';
  contract_type: 'DIGITDIFF' | 'DIGITMATCH' | 'DIGITEVEN' | 'DIGITODD';
  currency: string;
  duration: 1;
  duration_unit: 't';
  underlying_symbol: string;
  subscribe: 1;
  req_id: number;
  barrier?: string;
};
