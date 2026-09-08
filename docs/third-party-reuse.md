# Third-party source adaptations

Update owner: Sentinel maintainers. Updates require a reviewed diff against the pinned source and current acceptance evidence. Never pull upstream main automatically. Required license text is distributed in THIRD_PARTY_NOTICES.md. No upstream workflows, hooks, telemetry or runtime packages are imported.

## OpenHands failed-command loop guard

Repository: https://github.com/OpenHands/software-agent-sdk

Commit: `df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1`

Local destinations: `src/repair/failed-command-loop.ts`, its `tests/repair/failed-command-loop_test.ts` regressions, and the model-port integration.

Adaptation: retain the four-pair threshold; pair exact completed item IDs within a single thread/turn; deduplicate bounded observations; compare canonical command/result/content-checkpoint identity; exclude reasoning, prose, timestamps, successful/unknown outcomes and expected baseline failures; reset on progress; steer once and await exact settlement on interruption. No independent action/observation arrays, monologue detector, alternating detector or SDK event classes are copied. Tests are Sentinel-specific regression adaptations.

| Upstream path | SHA-256 |
| --- | --- |
| `clients/typescript/src/conversation/stuck-detector.ts` | `9d0402c4987d9deda39b1c3bf8f9109277970e138fc7fc08b4b00df787f9fd79` |
| `clients/typescript/src/__tests__/stuck-detector.test.ts` | `14de2ee02923023f42daa6362c4bf905672c138509390c1f9827806c131a798c` |
| `clients/typescript/LICENSE` | `5f81be7d1eee918d9b626e5b9b2f8fccd52d74d8f91c5e0402aaf3fe86e92399` |
| `LICENSE` | `14a9b631c658eee682c6c2973525fbdf808c3457176bc47513052c559cc5ce86` |
