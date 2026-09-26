/** Typed AlphaSolve workflow copy. */
export declare const NS = "alphasolve";
/** Simplified Chinese dictionary. */
export declare const zh: {
    readonly title: "AlphaSolve";
    readonly description: "按工作流与轮次查看各角色的执行记录";
    readonly header: "AlphaSolve · {count}";
    readonly empty: "此会话没有可显示的 AlphaSolve 工作流记录";
    readonly loading: "正在加载工作流";
    readonly loadFailed: "无法加载工作流记录";
    readonly retry: "重试";
    readonly worker: "Worker {id}";
    readonly auxiliary: "研究与整理";
    readonly round: "第 {round} 轮";
    readonly preparation: "准备与检查";
    readonly noRoles: "尚无角色会话记录";
    readonly open: "查看执行记录";
    readonly openRole: "查看 {role} 的执行记录";
    readonly steps: "{count} 步";
    readonly helpers: "助手会话（{count}）";
    readonly attempt: "第 {attempt} 次";
    readonly 'phase.created': "已创建";
    readonly 'phase.generator': "生成命题";
    readonly 'phase.verifier': "验证命题";
    readonly 'phase.reviser': "修订命题";
    readonly 'phase.theorem_checker': "检查定理";
    readonly 'phase.arbitrating': "判定验证结果";
    readonly 'phase.promoting': "保存结果";
    readonly 'phase.complete': "已结束";
    readonly 'terminal.verified': "已验证";
    readonly 'terminal.solved': "已解决";
    readonly 'terminal.rejected': "未通过验证";
    readonly 'terminal.failed': "失败";
    readonly 'terminal.cancelled': "已取消";
    readonly 'terminal.interrupted': "已中断";
    readonly 'terminal.stale_problem': "题目已变更";
    readonly 'terminal.write_conflict': "写入冲突";
    readonly 'terminal.discarded_after_solution': "其他工作流已解决";
    readonly 'run.running': "进行中";
    readonly 'run.completed': "已完成";
    readonly 'run.max_turns': "达到步数上限";
    readonly 'run.max_tokens': "达到输出上限";
    readonly 'run.aborted': "已中止";
    readonly 'run.blocked': "已阻止";
    readonly 'run.error': "出错";
    readonly 'run.disposed': "已关闭";
    readonly 'run.interrupted': "已中断";
    readonly 'role.generator': "生成器";
    readonly 'role.proposition_filename': "命题文件命名";
    readonly 'role.verifier': "验证器";
    readonly 'role.verifier_format_references': "格式与引用验证";
    readonly 'role.verifier_citation': "文献验证";
    readonly 'role.verifier_failure_modes': "失效模式验证";
    readonly 'role.verifier_stepwise': "逐步验证";
    readonly 'role.verifier_premise_chain': "前提链验证";
    readonly 'role.review_verdict_judge': "验证结果裁决";
    readonly 'role.reviser': "修订器";
    readonly 'role.theorem_checker': "定理检查器";
    readonly 'role.curator': "知识整理";
    readonly 'role.curator_helper': "知识整理助手";
    readonly 'role.compute': "计算助手";
    readonly 'role.numerical_experiment': "数值实验";
    readonly 'role.research_reviewer': "研究评审";
    readonly 'role.reasoning': "推理助手";
};
/** Dictionary key domain shared by both languages. */
export type AlphaSolveLocaleKey = keyof typeof zh;
/** English dictionary. */
export declare const en: Record<AlphaSolveLocaleKey, string>;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Workflow overview and role transcript navigation. */
        alphasolve: AlphaSolveLocaleKey;
    }
}
//# sourceMappingURL=locales.d.ts.map