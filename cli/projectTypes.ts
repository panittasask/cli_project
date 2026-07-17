export type ProjectCheck = {
    id: string;
    label: string;
    command: string;
    workdir: string;
    manifestPath: string;
    ecosystem: string;
    affectedExtensions: string[];
    affectedFiles: string[];
};

export type ProjectCheckProvider = {
    manifest: string;
    command: string;
    label?: string;
    ecosystem?: string;
    affectedExtensions?: string[];
    affectedFiles?: string[];
};

export type ProjectCompletionRequirement = {
    label: string;
    requireGoModule: boolean;
    requireGoJsonApi: boolean;
    requireReactApp: boolean;
    requireAngularApp: boolean;
    forbidReactArtifacts: boolean;
    forbidAngularArtifacts: boolean;
    requireFrontendApiCall: boolean;
    requireSwagger: boolean;
};
