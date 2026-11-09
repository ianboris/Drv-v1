# Lotus Crash/Boom scalper

## Multipliers route
The browser module uses Deriv's current Options WebSocket endpoints. It discovers active symbols with `MULTUP` / `MULTDOWN`, then verifies each Crash/Boom market with `contracts_for`. It requests a fresh demo OTP through Lotus's existing OAuth backend and sends proposals/buys only on the authenticated **demo** WebSocket.

The current experimental trigger is 9 of the previous 10 tick changes in one direction. It is a test harness, not a validated trading edge. Defaults: stake 0.35 account-currency units, multiplier 10x, one open contract, 60-second cooldown, and 1.00 daily demo loss stop. Proposal/contract errors must be reviewed against the selected account's actual currency and Deriv contract terms.

The journal is local to the browser. The daily stop and one-position guard are client-side controls, not server-enforced controls. Closing the browser stops the bot, but an already purchased contract remains open at Deriv until it settles or is managed in the Deriv platform. Do not treat this as production-safe unattended automation.

## MT5 CFD route
Deriv's MT5 account-management APIs do not provide MT5 trade execution. CFD execution is therefore a separate terminal integration. `mt5/LotusCrashBoomDemoEA.mq5` is an MQL5 Expert Advisor that must be compiled and attached to a Crash/Boom chart in Deriv MT5 desktop. It refuses to initialize unless the terminal reports a demo account.

Before testing:
1. Open a Deriv MT5 demo account in MT5 desktop.
2. Confirm the exact Crash/Boom symbol in Market Watch; symbol names vary by account/server.
3. Attach the EA to that chart and timeframe.
4. Set stop-loss and take-profit points only after reading that symbol's contract specification. Defaults are zero, so the EA does not place broker-side SL/TP until configured.
5. Run in Strategy Tester/demo first. It uses a simple EMA crossover, which is an experimental baseline, not a claim of predictive power.
6. Keep Algo Trading disabled outside controlled demo tests.

The EA is not controlled by the browser page and will not run from mobile/web MT5. The user must keep the MT5 desktop terminal running.

## Research cautions
Deriv describes the Crash/Boom number as an average tick frequency, not a countdown. Synthetic-index prices are generated, so a recent directional run does not establish that a spike is due or that momentum will persist. Backtest with chronological, out-of-sample data and include actual costs and execution effects before considering any live deployment.
