export type ClarificationOption = {
    id: string;
    label: string;
    description?: string;
};

export type ClarificationRequest = {
    question: string;
    options: ClarificationOption[];
    reason?: string;
};

export type ClarificationAnswer =
    | { kind: "option"; input: string; option: ClarificationOption }
    | { kind: "custom"; input: string; text: string }
    | { kind: "cancel"; input: string };
