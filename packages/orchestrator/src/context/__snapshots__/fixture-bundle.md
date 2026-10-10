### File: src/app.ts (typescript, 6 lines)
     1	import { parseHeader } from './parser';
     2	
     3	export function main(raw: string): string {
     4	  const header = parseHeader(raw);
     5	  return header.name.trim();
     6	}

### Folder: src/billing/ (2 files)
- src/billing/invoice.ts
- src/billing/tax.ts

### Selection: src/parser.ts (typescript, 400 lines, lines 200-202, partial)
[… lines 1-157 not shown; read_file startLine 1 endLine 157]
   158	// parser line 158
   159	// parser line 159
   160	// parser line 160
   161	// parser line 161
   162	// parser line 162
   163	// parser line 163
   164	// parser line 164
   165	// parser line 165
   166	// parser line 166
   167	// parser line 167
   168	// parser line 168
   169	// parser line 169
   170	// parser line 170
   171	// parser line 171
   172	// parser line 172
   173	// parser line 173
   174	// parser line 174
   175	// parser line 175
   176	// parser line 176
   177	// parser line 177
   178	// parser line 178
   179	// parser line 179
   180	// parser line 180
   181	// parser line 181
   182	// parser line 182
   183	// parser line 183
   184	// parser line 184
   185	// parser line 185
   186	// parser line 186
   187	// parser line 187
   188	// parser line 188
   189	// parser line 189
   190	// parser line 190
   191	// parser line 191
   192	// parser line 192
   193	// parser line 193
   194	// parser line 194
   195	// parser line 195
   196	// parser line 196
   197	// parser line 197
   198	// parser line 198
   199	// parser line 199
   200	export function parseHeader(input: string): Header {
   201	// parser line 201
   202	// parser line 202
   203	// parser line 203
   204	// parser line 204
   205	// parser line 205
   206	// parser line 206
   207	// parser line 207
   208	// parser line 208
   209	// parser line 209
   210	// parser line 210
   211	// parser line 211
   212	// parser line 212
   213	// parser line 213
   214	// parser line 214
   215	// parser line 215
   216	// parser line 216
   217	// parser line 217
   218	// parser line 218
   219	// parser line 219
   220	// parser line 220
   221	// parser line 221
   222	// parser line 222
   223	// parser line 223
   224	// parser line 224
   225	// parser line 225
   226	// parser line 226
   227	// parser line 227
   228	// parser line 228
   229	// parser line 229
   230	// parser line 230
   231	// parser line 231
   232	// parser line 232
   233	// parser line 233
   234	// parser line 234
   235	// parser line 235
   236	// parser line 236
   237	// parser line 237
   238	// parser line 238
   239	// parser line 239
   240	// parser line 240
   241	// parser line 241
   242	// parser line 242
   243	// parser line 243
   244	// parser line 244
   245	// parser line 245
[… lines 246-400 not shown; read_file startLine 246 endLine 400]

### Diff: uncommitted changes
diff --git a/.env b/.env
[may contain secrets, not shown; read_file asks the user first]
diff --git a/package-lock.json b/package-lock.json
[lockfile, not shown]
diff --git a/src/app.ts b/src/app.ts
index 734382c..430da01 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -2,5 +2,5 @@ import { parseHeader } from './parser';
 
 export function main(raw: string): string {
   const header = parseHeader(raw);
-  return header.name;
+  return header.name.trim();
 }

### Diff: staged changes
diff --git a/src/auth/session.ts b/src/auth/session.ts
index b9118ed..c487501 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1 +1 @@
-export const SESSION_TTL_S = 3600;
+export const SESSION_TTL_S = 1800;

### File: src/billing/invoice.ts (typescript, 3 lines)
     1	export function total(lines: number[]): number {
     2	  return lines.reduce((a, b) => a + b, 0);
     3	}

### File: src/billing/tax.ts (typescript, 1 line)
     1	export const VAT = 0.21;

### Open editor: README.md (markdown, 3 lines)
     1	# Fixture
     2	
     3	A small service used by the context engine tests.

### Open editor: src/auth/session.ts (typescript, 1 line)
     1	export const SESSION_TTL_S = 1800;

### Repository map (17 files, gitignored files left out; typescript 6, dotenv 2, json 2, dockerfile 1, ignore 1, markdown 1, sql 1, terraform 1):
.github/ (1 file)
  workflows/ (1 file)
    ci.yml
config/ (1 file)
  secrets/ (1 file)
    prod.json
db/ (1 file)
  migrations/ (1 file)
    001_init.sql
infra/ (1 file)
  main.tf
src/ (6 files)
  auth/ (1 file)
    session.ts
  billing/ (2 files)
    invoice.ts
    tax.ts
  payments-api/ (1 file)
    charge.ts
  app.ts
  parser.ts
.env
.env.example
.gitignore
Dockerfile
README.md
data.bin.txt
package.json

### Not included (use read_file, list_files, search, or git_read if you need them)
- .env: may contain secrets, not shown; read_file asks the user first
- package-lock.json: lockfile, not shown