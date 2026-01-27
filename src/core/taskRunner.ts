
import * as vscode from 'vscode';
export class TaskRunner { static async runShell(label:string, command:string, cwd?:string): Promise<number>{ const def:vscode.TaskDefinition = {type:'shell'}; const exec = new vscode.ShellExecution(command,{cwd}); const task = new vscode.Task(def, vscode.TaskScope.Workspace, label, 'orchestrator', exec); return new Promise<number>((resolve)=>{ const disp = vscode.tasks.onDidEndTaskProcess(e=>{ if (e.execution.task===task){ disp.dispose(); resolve(e.exitCode ?? -1); } }); vscode.tasks.executeTask(task); }); } }
