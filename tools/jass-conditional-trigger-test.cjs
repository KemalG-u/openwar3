// Issue #295: an explicit conditional run evaluates a disabled trigger too.
// These synthetic JASS functions exercise the real runtime without game assets.
// Build: pnpm exec tsc -p tools/tsconfig.jass.json
// Run:   node tools/jass-conditional-trigger-test.cjs
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(REPO, ".jass-build", "src", "jass", "headless.js"));

const SRC = `
globals
    trigger target = null
    integer evaluations = 0
    integer runs = 0
    boolean allowed = true
    boolean selfGuard = false
    boolean conditionSawSelf = false
    boolean actionSawSelf = false
endglobals

function Check takes nothing returns boolean
    set evaluations = evaluations + 1
    set conditionSawSelf = GetTriggeringTrigger() == target
    return allowed and (not selfGuard or IsTriggerEnabled(GetTriggeringTrigger()))
endfunction

function Act takes nothing returns nothing
    set runs = runs + 1
    set actionSawSelf = GetTriggeringTrigger() == target
    if selfGuard then
        call DisableTrigger(GetTriggeringTrigger())
    endif
endfunction

function Setup takes boolean enabled, boolean result, boolean guard returns nothing
    set allowed = result
    set selfGuard = guard
    set target = CreateTrigger()
    call TriggerAddCondition(target, Condition(function Check))
    call TriggerAddAction(target, function Act)
    if not enabled then
        call DisableTrigger(target)
    endif
endfunction

function Run takes nothing returns nothing
    call ConditionalTriggerExecute(target)
endfunction
`;

let failures = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: want ${want}, got ${got}`}`);
};
const bool = (b) => ({ k: "bool", b });

for (const route of ["native", "statement"]) {
  const make = (enabled, allowed, selfGuard) => {
    const interp = buildInterpreter([SRC]);
    interp.callFunction("Setup", [bool(enabled), bool(allowed), bool(selfGuard)]);
    const target = interp.rt.globals.get("target");
    const run = () => route === "native"
      ? interp.callFunction("ConditionalTriggerExecute", [target])
      : interp.callFunction("Run", []);
    const value = (name) => interp.rt.globals.get(name);
    return { interp, target, run, value };
  };

  // Reinstating the erroneous enabled gate must fail this case on EACH path.
  const passing = make(false, true, false);
  passing.run();
  check(`${route}: disabled trigger's condition is evaluated`, passing.value("evaluations")?.n, 1);
  check(`${route}: true condition runs the disabled trigger's action`, passing.value("runs")?.n, 1);
  check(`${route}: condition sees the triggering trigger`, passing.value("conditionSawSelf")?.b, true);
  check(`${route}: action sees the triggering trigger`, passing.value("actionSawSelf")?.b, true);
  check(`${route}: explicit execution does not enable the trigger`,
    passing.interp.callFunction("IsTriggerEnabled", [passing.target])?.b, false);
  check(`${route}: triggering context is restored`, passing.interp.rt.eventStack.length, 0);

  // Removing the condition check altogether must fail this negative case.
  const refusing = make(false, false, false);
  refusing.run();
  check(`${route}: disabled trigger's false condition is still evaluated`, refusing.value("evaluations")?.n, 1);
  check(`${route}: false condition prevents the action`, refusing.value("runs")?.n, 0);

  // The editor's run-once pattern guards ITSELF in its condition. It must retain
  // that choice even though explicit execution no longer imposes an extra gate.
  const once = make(true, true, true);
  once.run();
  once.run();
  check(`${route}: run-once condition is evaluated on both attempts`, once.value("evaluations")?.n, 2);
  check(`${route}: the trigger's own enabled condition keeps it run-once`, once.value("runs")?.n, 1);
}

console.log(failures ? `\n${failures} FAILED` : "\nall conditional trigger checks passed");
process.exit(failures ? 1 : 0);
