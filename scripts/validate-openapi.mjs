import SwaggerParser from '@apidevtools/swagger-parser';
import { fileURLToPath } from 'node:url';
const spec = await SwaggerParser.validate(fileURLToPath(new URL('../openapi.json',import.meta.url)));
const count = Object.values(spec.paths).reduce((sum,path)=>sum+Object.keys(path).filter(method=>['get','post','put','delete','patch'].includes(method)).length,0);
if (count!==10) throw new Error('Expected ten operations');
console.log('PASS OpenAPI schema and ten operations');

