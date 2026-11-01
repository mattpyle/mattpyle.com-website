const unused = (verb: string) => async (): Promise<never> => {
  throw new Error(`no ${verb} run in this test`);
};

/** The restart, commit and run options a console test does not care about: a fixed commit, a restart that starts nothing, and verbs that fail if called. */
export const CONSOLE_RESTART_STUBS = {
  commit: 'abc1234',
  behindMaster: false,
  spawnReplacement: (): void => {},
  exitProcess: (): void => {},
  runSync: unused('sync'),
  runFix: unused('fix'),
  runVerify: unused('verify'),
};
