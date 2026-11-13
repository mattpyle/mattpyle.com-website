// Names shared by the workflow, the worker and any caller. No imports, so anything may load it.

/** The workflow type, the name a caller starts a session by. */
export const AGENT_NAME = 'AuditConsultant';
/** The name the worker's StrandsPlugin registers the model factory under. */
export const MODEL = 'claude';
/** The Query that returns the session's counts and, once a cap ends it, the reason. */
export const SESSION_QUERY = 'consultant_session';
