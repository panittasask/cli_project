export type ClarificationOption = {
    id: string;
    label: string;
    description?: string;
};

export type ClarificationRequest = {
    question: string;
    options: ClarificationOption[];
    decision: "target" | "scope" | "compatibility" | "destructive" | "cost" | "external" | "preference";
    reason?: string;
};

export type ClarificationAnswer =
    | { kind: "option"; input: string; option: ClarificationOption }
    | { kind: "custom"; input: string; text: string }
    | { kind: "cancel"; input: string };
