# Locode Project Guidelines

## Code Style & Architecture
- All modules must be written in TypeScript ESM (`"type": "module"`).
- Always keep functions pure and modular where possible.
- Never write whole-file replacements if a small `edit_file` diff can be applied.
- Prefer explicit interfaces in `src/types.ts` over inline `any`.

## Testing
- Tests are executed using Node.js native test runner via `npm test`.
- Add test coverage for any new tool or provider in `tests/`.
