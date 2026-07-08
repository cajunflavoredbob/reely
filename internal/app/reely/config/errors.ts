import { ReelyError } from '../util/assert';

export class ConfigFileNotFoundError extends ReelyError {}

export class ConfigMustBeRecord extends ReelyError {}
export class HostNameMustBeString extends ReelyError {}
export class PortMustBeNumber extends ReelyError {}
export class LogLevelInvalid extends ReelyError {}
export class ServersMustBeArray extends ReelyError {}
export class ServersMustNotBeEmpty extends ReelyError {}
export class ServerMustBeRecord extends ReelyError {}
export class ServerTypeInvalid extends ReelyError {}
export class ServerUrlMustBeString extends ReelyError {}
export class ServerUrlInvalid extends ReelyError {}
export class ServerTokenMustBeString extends ReelyError {}
export class ServerLibraryTitleFilterInvalid extends ReelyError {}
export class ServerBasePathInvalid extends ReelyError {}
export class BasicAuthInvalid extends ReelyError {}
export class BasicAuthUserNameInvalid extends ReelyError {}
export class BasicAuthPasswordInvalid extends ReelyError {}
export class TlsConfigInvalid extends ReelyError {}
export class TlsConfigCertFileInvalid extends ReelyError {}
export class TlsConfigKeyFileInvalid extends ReelyError {}
export class ExposePlexBaseUrlInvalid extends ReelyError {}
