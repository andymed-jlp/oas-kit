'use strict';

const fs = require('fs');
const path = require('path');

const yaml = require('yaml');
const should = require('should/as-function');

let rules = [];
let results = [];

function applyRules(ruleData,parent) {
    if (ruleData.require) {
        let newFile = ruleData.require;
        if (path.extname(newFile) === '') {
            newFile += path.extname(parent);
        }
        if (path.dirname(newFile) === '') {
            newFile = path.join(path.dirname(parent),newFile);
        }
        loadRules(newFile);
    }
    let newRules = ruleData.rules;

    for (let rule of newRules) {
        if (!rule.url) rule.url = ruleData.url;
        if (!Array.isArray(rule.object)) rule.object = [ rule.object ];
        if (rule.truthy && !Array.isArray(rule.truthy)) rule.truthy = [ rule.truthy ];
    }

    let hash = new Map();
    rules.concat(newRules).forEach(function(rule) {
        hash.set(rule.name, Object.assign(hash.get(rule.name) || {}, rule));
    });
    rules = Array.from(hash.values()).filter(function(e){ return !e.disabled; });
    results = [];
    return rules;
}

function loadRules(s,schema,instance) {
    let data = fs.readFileSync(s,'utf8');
    let ruleData = yaml.parse(data,{schema:'core'});
    applyRules(ruleData,s);
    return rules;
}

const regexFromString = regex => new RegExp(regex.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, "\\$&"));

const ensureRule = (context, rule, shouldAssertion) => {
    try {
        shouldAssertion();
    }
    catch (error) {
        // rethrow when not a lint error
        if (!error.name || error.name !== 'AssertionError') {
            throw error;
        }

        const pointer = (context && context.length > 0 ? context[context.length-1] : null);
        return { pointer, rule, ruleName: rule.name, error, dataPath: pointer, keyword: 'lint', message: error.message, url: rules.url };
    }
};

function lint(objectName,object,key,options) {

    if (!options.metadata.count) {
        options.metadata.count = {};
    }
    if (!options.metadata.count[objectName]) {
        options.metadata.count[objectName] = 0;
    }
    options.metadata.count[objectName]++;

    const ensure = (rule, func) => {
        const result = ensureRule(options.context, rule, func);
        if (result) results.push(result);
    };

    for (let rule of rules) {
        if ((rule.object[0] === '*') || (rule.object.indexOf(objectName)>=0)) {
            if (options.verbose > 2) console.warn('Linting',rule.name,'@',rule.object,'for',objectName);
            if (rule.skip && options[rule.skip]) {
                continue;
            }
            if (options.lintSkip && options.lintSkip.indexOf(rule.name)>=0) {
                continue;
            }
            let matched = false;
            if (rule.conditions || rule.condition) {
                let failed = false;

                let conditions = [];
                if (rule.conditions) {
                    conditions = conditions.concat(rule.conditions);
                }

                if (rule.condition) {
                    conditions.push(rule.condition);
                }

                for (let condition of conditions) {
                    const property =
                        (condition.property === '$path') ? options.context[options.context.length-1] :
                            (condition.property === '$key') ? key : object[condition.property];

                    if (condition.value && property != condition.value) {
                        failed = true;
                        break;
                    }

                    if (condition.pattern) {
                        let re = new RegExp(condition.pattern);
                        if (!re.test(property)) {
                            failed = true;
                            break;
                        }
                    }

                    if (condition.notPattern) {
                        let re = new RegExp(condition.notPattern);
                        if (re.test(property)) {
                            failed = true;
                            break;
                        }
                    }
                }
                if (failed)
                    continue;
            }
            if (rule.truthy) {
                matched = true;
                for (let property of rule.truthy) {
                    ensure(rule, () => {
                        should(object).have.property(property);
                        should(object[property]).not.be.undefined();
                        should(object[property]).not.be.empty();
                    });
                }
            }
            if (rule.alphabetical) {
                matched = true;
                for (const property of rule.alphabetical.properties) {
                    if (!object[property] || object[property].length < 2) {
                        continue;
                    }

                    const arrayCopy = object[property].slice(0);

                    // If we aren't expecting an object keyed by a specific property, then treat the
                    // object as a simple array.
                    if (rule.alphabetical.keyedBy) {
                        const keyedBy = [rule.alphabetical.keyedBy];
                        arrayCopy.sort(function (a, b) {
                            if (a[keyedBy] < b[keyedBy]) {
                                return -1;
                            }
                            else if (a[keyedBy] > b[keyedBy]) {
                                return 1;
                            }
                            return 0;
                        });
                    }
                    else {
                        arrayCopy.sort()
                    }
                    ensure(rule, () => {
                        should(object).have.property(property);
                        should(object[property]).be.deepEqual(arrayCopy);
                    });
                }
            }
            if (rule.properties) {
                matched = true;
                ensure(rule, () => {
                    should(Object.keys(object).length).be.exactly(rule.properties);
                });
            }
            if (rule.or) {
                matched = true;
                let found = false;

                if (rule.or.property) {
                    const property =
                        (rule.or.property === '$path') ? options.context[options.context.length-1] :
                            (rule.or.property === '$key') ? key : object[rule.or.property];
                    for (let value of rule.or.value) {
                        if (value == property) found = true;
                    }

                } else {
                    for (let property of rule.or) {
                        if (typeof object[property] !== 'undefined') found = true;
                    }
                }
                ensure(rule, () => {
                    should(found).be.exactly(true,rule.description);
                });
            }
            if (rule.xor) {
                matched = true;
                let found = false;
                for (let property of rule.xor) {
                    if (typeof object[property] !== 'undefined') {
                        if (found) {
                            ensure(rule, () => {
                                should.fail(true,false,rule.description);
                            });
                        }
                        found = true;
                    }
                }
                ensure(rule, () => {
                    should(found).be.exactly(true,rule.description);
                });
            }
            if (rule.pattern) {
                matched = true;
                let components = [];
                const property =
                    (rule.pattern.property === '$path') ? options.context[options.context.length-1] :
                        (rule.pattern.property === '$key') ? key : object[rule.pattern.property];
                if (rule.pattern.split) {
                    components = property.split(rule.pattern.split);
                }
                else {
                    components.push(property);
                }

                let re = new RegExp(rule.pattern.value);
                for (let component of components) {
                    if (component) {
                        if (rule.pattern.omit && component.split)
                            component = component.split(rule.pattern.omit).join('');
                        if (component) {
                            ensure(rule, () => {
                                should(re.test(component)).be.exactly(true, rule.description);
                            });
                        }
                    }
                }
            }
            if (rule.notPattern) {
                matched = true;
                let components = [];
                const property =
                    (rule.notPattern.property === '$path') ? options.context[options.context.length-1] :
                        (rule.notPattern.property === '$key') ? key : object[rule.notPattern.property];
                if (rule.notPattern.split) {
                    components = property.split(rule.notPattern.split);
                }
                else {
                    components.push(property);
                }

                if (rule.notPattern.values) {
                    for (let value of rule.notPattern.values) {
                        let re = new RegExp(value);
                        for (let component of components) {
                            if (component) {
                                if (rule.notPattern.omit) component = component.split(rule.notPattern.omit).join('');
                                if (component) {
                                    ensure(rule, () => {
                                        should(re.test(component)).be.exactly(false, rule.description + " (" + value + ")");
                                    });
                                }
                            }
                        }
                    }

                } else {
                    let re = new RegExp(rule.notPattern.value);
                    for (let component of components) {
                        if (component) {
                            if (rule.notPattern.omit) component = component.split(rule.notPattern.omit).join('');
                            if (component) {
                                ensure(rule, () => {
                                    should(re.test(component)).be.exactly(false, rule.description);
                                });
                            }
                        }
                    }
                }
            }
            if (rule.notContain) {
                matched = true;
                for (let property of rule.notContain.properties) {
                    let match;
                    let pattern = rule.notContain.pattern;
                    let value = pattern ? pattern.value : rule.notContain.value;
                    match = regexFromString(value);
                    if (typeof pattern !== 'undefined') {
                        let flags = (pattern && typeof pattern.flags !== 'undefined') ? pattern.flags : '';
                        match = new RegExp(pattern, flags);
                    }
                    if (typeof object[property] !== 'undefined') {
                        ensure(rule, () => {
                            should(object[property]).be.a.String().and.not.match(match, rule.description);
                        });
                    }
                }
            }
            if (rule.notEndWith) {
                matched = true;
                let property =
                    (rule.notEndWith.property === '$path') ? options.context[options.context.length-1] :
                        (rule.notEndWith.property === '$key') ? key : object[rule.notEndWith.property];
                if (typeof property === 'string') {
                    if (rule.notEndWith.omit) {
                        property = property.replace(rule.notEndWith.omit,'');
                    }
                    ensure(rule, () => {
                        should(property).not.endWith(rule.notEndWith.value);
                    });
                }
            }
            if (rule.if) {
                matched = true;
                let property =
                    (rule.if.property === '$path') ? options.context[options.context.length-1] :
                        (rule.if.property === '$key') ? key : object[rule.if.property];
                if (property) {
                    let thenProp =
                        (rule.if.property === '$path') ? options.context[options.context.length-1] :
                            (rule.if.then.property === '$key') ? key : object[rule.if.then.property];
                    ensure(rule, () => {
                        should(thenProp).equal(rule.if.then.value,rule.name+' if.then test failed:'+thenProp+' != '+rule.if.then.value);
                    });
                }
                else {
                    if (rule.else) {
                        let elseProp =
                            (rule.if.property === '$path') ? options.context[options.context.length-1] :
                                (rule.if.else.property === '$key') ? key : object[rule.if.else.property];
                        ensure(rule, () => {
                            should(elseProp).equal(rule.if.else.value,rule.name+' if.else test failed:'+elseProp+' != '+rule.if.else.value);
                        });
                    }
                }
            }
            if (rule.maxLength) {
                matched = true;
                const { value, property } = rule.maxLength;
                if (object[property] && (typeof object[property] === 'string')) {
                    ensure(rule, () => {
                        should(object[property].length).be.belowOrEqual(value)
                    });
                }
            }
            if (rule.schema) {
                matched = true;
                const validate = options.ajv.compile(rule.schema);
                const valid = validate(object);
                if (!valid) {
                    const pointer = (options.context && options.context.length > 0 ? options.context[options.context.length-1] : null);
                    for (let error of validate.errors) {
                        results.push({ pointer, rule, ruleName: rule.name, error, dataPath: pointer, keyword: 'lint', message: error.dataPath + ' ' + error.message, url: rules.url });
                    }
                }
            }
            if (!matched && options.verbose) console.warn('Linter rule did not match any known rule-types',rule.name);
        }
    }
}

module.exports = {
    lint : lint,
    loadRules : loadRules,
    applyRules : applyRules,
    loadDefaultRules : function() { return loadRules(path.join(__dirname,'rules.yaml')) },
    getRules : function() { return { rules }; },
    getResults : function() { return results; }
};

