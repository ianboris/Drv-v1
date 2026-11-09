-- Extend the research journal to support the independent Even and Odd paper engines.
-- Existing DIFFERS and MATCHES records remain valid. No execution permissions are added.
ALTER TABLE public.ddpe_research_decisions
  DROP CONSTRAINT IF EXISTS ddpe_research_decisions_strategy_check;

ALTER TABLE public.ddpe_research_decisions
  ADD CONSTRAINT ddpe_research_decisions_strategy_check
  CHECK (strategy IN ('DIFFERS', 'MATCHES', 'EVEN', 'ODD'));
