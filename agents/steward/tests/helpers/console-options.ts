/** The restart and commit options a console test does not care about: a fixed commit, and a restart that starts nothing. */
export const CONSOLE_RESTART_STUBS = {
  commit: 'abc1234',
  behindMaster: false,
  spawnReplacement: (): void => {},
  exitProcess: (): void => {},
};
