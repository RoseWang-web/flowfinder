/**
 * embindPatch.ts — make face_mesh's Emscripten glue run under the extension CSP.
 *
 * MV3 extension pages forbid 'unsafe-eval'. Emscripten's embind generates
 * three kinds of functions from strings at start-up / first call:
 *   1. createNamedFunction        — `new Function(...)` for a named wrapper
 *   2. craftInvokerFunction       — `new_(Function, …)` for JS→C++ call wrappers
 *   3. __emval_get_method_caller  — `new_(Function, …)` for C++→JS method calls
 * Each is replaced with a closure that does exactly what the generated code
 * did (later Emscripten versions ship the same idea as DYNAMIC_EXECUTION=0).
 *
 * Only this JS glue changes; the .wasm and model data are copied byte for byte.
 * The build fails if upstream code no longer matches, and embindPatch.test.ts
 * checks that original and patched functions behave identically.
 */

interface Replacement { name: string; pattern: RegExp; safe: string }

const REPLACEMENTS: Replacement[] = [
  {
    name: 'createNamedFunction',
    pattern: /function createNamedFunction\(name,body\)\{name=makeLegalFunctionName\(name\);return new Function\([^]*?\)\(body\)\}/g,
    safe:
      'function createNamedFunction(name,body){name=makeLegalFunctionName(name);' +
      'return{[name]:function(){"use strict";return body.apply(this,arguments)}}[name]}',
  },
  {
    name: 'craftInvokerFunction',
    pattern: /function craftInvokerFunction\(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc\)\{[^]*?var invokerFunction=new_\(Function,args1\)\.apply\(null,args2\);return invokerFunction\}/g,
    safe: `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){
var argCount=argTypes.length;
if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}
var isClassMethodFunc=argTypes[1]!==null&&classType!==null;
var needsDestructorStack=false;
for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}
var returns=argTypes[0].name!=="void";
var expected=argCount-2;
var firstArgSlot=isClassMethodFunc?2:1;
return createNamedFunction(humanName,function(){
if(arguments.length!==expected){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expected+" args!")}
var destructors=needsDestructorStack?[]:null;
var wired=[cppTargetFunc];
var thisWired;
if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);wired.push(thisWired)}
for(var i=0;i<expected;++i){wired.push(argTypes[i+2].toWireType(destructors,arguments[i]))}
var rv=cppInvokerFunc.apply(null,wired);
if(needsDestructorStack){runDestructors(destructors)}
else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(i===1?thisWired:wired[firstArgSlot+i-2])}}}
if(returns){return argTypes[0].fromWireType(rv)}
})}`.replace(/\n/g, ''),
  },
  {
    name: '__emval_get_method_caller',
    pattern: /function __emval_get_method_caller\(argCount,argTypes\)\{[^]*?var invokerFunction=new_\(Function,params\)\.apply\(null,args\);return __emval_addMethodCaller\(invokerFunction\)\}/g,
    safe: `function __emval_get_method_caller(argCount,argTypes){
var types=__emval_lookupTypes(argCount,argTypes);
var retType=types[0];
var signatureName=retType.name+"_$"+types.slice(1).map(function(t){return t.name}).join("_")+"$";
var functionName="methodCaller_"+signatureName;
var invokerFunction=createNamedFunction(functionName,function(handle,name,destructors,args){
var argv=new Array(argCount-1);var offset=0;
for(var i=0;i<argCount-1;++i){argv[i]=types[1+i].readValueFromPointer(args+offset);offset+=types[i+1]["argPackAdvance"]}
var rv=handle[name].apply(handle,argv);
for(var i=0;i<argCount-1;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(argv[i])}}
if(!retType.isVoid){return retType.toWireType(destructors,rv)}
});
return __emval_addMethodCaller(invokerFunction)}`.replace(/\n/g, ''),
  },
]

export function patchEmbind(source: string, file: string): string {
  let out = source
  for (const r of REPLACEMENTS) {
    const n = out.match(r.pattern)?.length ?? 0
    if (n !== 1) throw new Error(`${file}: expected 1 embind ${r.name}, found ${n}`)
    out = out.replace(r.pattern, () => r.safe)
  }
  if (/new Function\(|new_\(Function|[^\w.$]eval\(/.test(out)) {
    throw new Error(`${file}: still contains eval / new Function`)
  }
  return out
}
