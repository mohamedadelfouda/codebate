// Unit-test twin of test/git/_runtime-isolation.mjs: redirect the runtime root to a fresh throwaway
// directory BEFORE store.js / logger.js load and freeze it. Without this, unit tests write session files
// and logs into the real checkout, and reconcileInterruptedRuns marks a live session "interrupted".
// Import this as the FIRST line of any unit test that loads runtime-touching server code;
// test/unit/test-runtime-isolation.test.js enforces that.
import "../git/_runtime-isolation.mjs";
