
import * as fs from 'fs';
import * as path from 'path';
export type Detected = { kind: 'node'|'dotnet'|'python'|'unknown', steps: { pre:string, work:string, post:string } };
export function detectWorkspace(ws: string): Detected {
  const has = (p:string)=> fs.existsSync(path.join(ws,p));
  if (has('package.json')) {return { kind:'node', steps:{ pre:'npm ci', work:'npm run work || npm run build', post:'npm test && npm run docs || true' } };}
  if (['.sln','.csproj'].some(ext => fs.readdirSync(ws).some(f=>f.endsWith(ext)))) {return { kind:'dotnet', steps:{ pre:'dotnet restore', work:'dotnet build -c Release', post:'dotnet test --collect:"XPlat Code Coverage"' } };}
  if (has('pyproject.toml') || has('requirements.txt')) {return { kind:'python', steps:{ pre:'python -m pip install -r requirements.txt || true', work:'pytest -q || true', post:'coverage xml || true' } };}
  return { kind:'unknown', steps:{ pre:'echo pre', work:'echo work', post:'echo post' } };
}
