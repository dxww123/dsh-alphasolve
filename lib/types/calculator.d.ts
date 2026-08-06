import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare const CALCULATOR_TOOL_NAME = "alphasolve_calculate";
export interface CalculatorLimits {
    readonly maxLength?: number;
    readonly maxNodes?: number;
    readonly maxSteps?: number;
    readonly maxDepth?: number;
}
export interface EvaluateExpressionOptions extends CalculatorLimits {
    readonly signal?: AbortSignal;
}
export type ExpressionErrorCode = 'INVALID_EXPRESSION' | 'UNKNOWN_IDENTIFIER' | 'INVALID_ARITY' | 'NON_FINITE_RESULT' | 'LIMIT_EXCEEDED' | 'CANCELLED';
export declare class ExpressionEvaluationError extends Error {
    readonly code: ExpressionErrorCode;
    constructor(code: ExpressionErrorCode, message: string);
}
/** Evaluate one side-effect-free arithmetic expression using the fixed grammar. */
export declare function evaluateExpression(expression: string, options?: EvaluateExpressionOptions): number;
/** Construct the scoped calculator tool installed for approved helper roles. */
export declare function createCalculatorTool(limits?: CalculatorLimits): ToolDefinition;
//# sourceMappingURL=calculator.d.ts.map