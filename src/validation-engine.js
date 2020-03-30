const ValidationReport = require('./validation-report')
const error = require('debug')('validation-enging::error')

class ValidationEngine {
  constructor (context, options) {
    this.context = context
    this.factory = context.factory
    this.conformanceOnly = options.conformanceOnly
    this.maxErrors = options.maxErrors
    this.results = []
    this.recordErrorsLevel = 0
    this.violationsCount = 0
    this.validationError = null
  }

  addResultProperty (result, predicate, object) {
    this.results.push(this.factory.quad(result, predicate, object))
  }

  /**
   * Creates a new BlankNode holding the SHACL validation result, adding the default
   * properties for the constraint, focused node and value node
   */
  createResult (constraint, focusNode, valueNode) {
    const { rdf, sh } = this.factory.ns
    const result = this.factory.blankNode()
    const severity = constraint.shape.severity
    const sourceConstraintComponent = constraint.component.node
    const sourceShape = constraint.shape.shapeNode
    this.addResultProperty(result, rdf.type, sh.ValidationResult)
    this.addResultProperty(result, sh.resultSeverity, severity)
    this.addResultProperty(result, sh.sourceConstraintComponent, sourceConstraintComponent)
    this.addResultProperty(result, sh.sourceShape, sourceShape)
    this.addResultProperty(result, sh.focusNode, focusNode)
    if (valueNode) {
      this.addResultProperty(result, sh.value, valueNode)
    }
    return result
  }

  /**
   * Creates all the validation result nodes and messages for the result of applying the validation logic
   * of a constraints against a node.
   * Result passed as the first argument can be false, a resultMessage or a validation result object.
   * If none of these values is passed no error result or error message will be created.
   */
  createResultFromObject (obj, constraint, focusNode, valueNode) {
    const { sh, xsd } = this.factory.ns

    if (obj === false) {
      if (this.recordErrorsLevel > 0) {
        if (this.conformanceOnly) {
          return false
        } else {
          return true
        }
      }

      if (this.conformanceOnly) {
        return false
      }
      const result = this.createResult(constraint, focusNode, valueNode)
      if (constraint.shape.isPropertyShape()) {
        this.addResultProperty(result, sh.resultPath, constraint.shape.path) // TODO: Make deep copy
      }
      this.createResultMessages(result, constraint)
      return true
    } else if (typeof obj === 'string') {
      if (this.recordErrorsLevel > 0) {
        if (this.conformanceOnly) {
          return false
        } else {
          return true
        }
      }
      if (this.conformanceOnly) {
        return false
      }
      const result = this.createResult(constraint, focusNode, valueNode)
      if (constraint.shape.isPropertyShape()) {
        this.addResultProperty(result, sh.resultPath, constraint.shape.path) // TODO: Make deep copy
      }
      this.addResultProperty(result, sh.resultMessage, this.factory.literal(obj, xsd.string))
      this.createResultMessages(result, constraint)
      return true
    } else if (typeof obj === 'object') {
      if (this.recordErrorsLevel > 0) {
        if (this.conformanceOnly) {
          return false
        } else {
          return true
        }
      }
      if (this.conformanceOnly) {
        return false
      }
      const result = this.createResult(constraint, focusNode)
      if (obj.path) {
        this.addResultProperty(result, sh.resultPath, obj.path) // TODO: Make deep copy
      } else if (constraint.shape.isPropertyShape()) {
        this.addResultProperty(result, sh.resultPath, constraint.shape.path) // TODO: Make deep copy
      }
      if (obj.value) {
        this.addResultProperty(result, sh.value, obj.value)
      } else if (valueNode) {
        this.addResultProperty(result, sh.value, valueNode)
      }
      if (obj.message) {
        this.addResultProperty(result, sh.resultMessage, this.factory.literal(obj.message, xsd.string))
      } else {
        this.createResultMessages(result, constraint)
      }
      return true
    }
    return false
  }

  /**
   * Creates a result message from the result and the message pattern in the constraint
   */
  createResultMessages (result, constraint) {
    const { sh } = this.factory.ns

    // 1. Try to get message from the shape itself
    let ms = [...this.context.$shapes
      .match(constraint.shape.shapeNode, sh.message, null)]
      .map(({ object }) => object)

    // 2. Try to get message from the constraint component validator
    if (ms.length === 0) {
      ms = constraint.componentMessages.map((m) => this.factory.literal(m))
    }

    // 3. Try to get message from the constraint focus node
    if (ms.length === 0) {
      ms = [...this.context.$shapes
        .match(constraint.component.node, sh.message, null)]
        .map(({ object }) => object)
    }

    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]
      const str = this.withSubstitutions(m, constraint)
      this.addResultProperty(result, sh.resultMessage, str)
    }
  }

  /**
   * Validates the data graph against the shapes graph
   */
  validateAll (rdfDataGraph) {
    if (this.maxErrorsReached()) {
      return true
    } else {
      this.validationError = null

      try {
        this.results = []
        let foundError = false
        const shapes = this.context.shapesGraph.getShapesWithTarget()
        for (let i = 0; i < shapes.length; i++) {
          const shape = shapes[i]
          const focusNodes = shape.getTargetNodes(rdfDataGraph)
          for (let j = 0; j < focusNodes.length; j++) {
            if (this.validateNodeAgainstShape(focusNodes[j], shape, rdfDataGraph)) {
              foundError = true
            }
          }
        }
        return foundError
      } catch (e) {
        this.validationError = e
        return true // Really? Why do we even return a boolean here?
      }
    }
  }

  /**
   * Returns true if any violation has been found
   */
  validateNodeAgainstShape (focusNode, shape, rdfDataGraph) {
    if (this.maxErrorsReached()) {
      return true
    } else {
      if (shape.deactivated) {
        return false
      }
      const constraints = shape.getConstraints()
      const valueNodes = shape.getValueNodes(focusNode, rdfDataGraph)
      let errorFound = false
      for (let i = 0; i < constraints.length; i++) {
        if (this.validateNodeAgainstConstraint(focusNode, valueNodes, constraints[i], rdfDataGraph)) {
          errorFound = true
        }
      }
      return errorFound
    }
  }

  validateNodeAgainstConstraint (focusNode, valueNodes, constraint, rdfDataGraph) {
    const { sh } = this.factory.ns

    if (this.maxErrorsReached()) {
      return true
    } else {
      if (sh.PropertyConstraintComponent.equals(constraint.component.node)) {
        let errorFound = false
        for (let i = 0; i < valueNodes.length; i++) {
          if (this.validateNodeAgainstShape(valueNodes[i], this.context.shapesGraph.getShape(constraint.paramValue), rdfDataGraph)) {
            errorFound = true
          }
        }
        return errorFound
      } else {
        const validationFunction = constraint.shape.isPropertyShape()
          ? constraint.component.propertyValidationFunction
          : constraint.component.nodeValidationFunction
        if (validationFunction) {
          const generic = constraint.shape.isPropertyShape()
            ? constraint.component.propertyValidationFunctionGeneric
            : constraint.component.nodeValidationFunctionGeneric
          if (generic) {
            // Generic sh:validator is called for each value node separately
            let errorFound = false
            for (let i = 0; i < valueNodes.length; i++) {
              if (this.maxErrorsReached()) {
                break
              }
              let iterationError = false
              const valueNode = valueNodes[i]
              // if (validationFunction.funcName === "validateAnd" || validationFunction.funcName === "validateOr" || validationFunction.funcName === "validateNot") {
              this.recordErrorsLevel++
              // }
              const obj = validationFunction.execute(focusNode, valueNode, constraint)
              // if (validationFunction.funcName === "validateAnd" || validationFunction.funcName === "validateOr" || validationFunction.funcName === "validateNot") {
              this.recordErrorsLevel--
              // }
              if (Array.isArray(obj)) {
                for (let a = 0; a < obj.length; a++) {
                  if (this.createResultFromObject(obj[a], constraint, focusNode, valueNode)) {
                    iterationError = true
                  }
                }
              } else {
                if (this.createResultFromObject(obj, constraint, focusNode, valueNode)) {
                  iterationError = true
                }
              }
              if (iterationError) {
                this.violationsCount++
              }
              errorFound = errorFound || iterationError
            }
            return errorFound
          } else {
            // if (validationFunction.funcName === "validateAnd" || validationFunction.funcName === "validateOr" || validationFunction.funcName === "validateNot") {
            this.recordErrorsLevel++
            // }
            const obj = validationFunction.execute(focusNode, null, constraint)
            // if (validationFunction.funcName === "validateAnd" || validationFunction.funcName === "validateOr" || validationFunction.funcName === "validateNot") {
            this.recordErrorsLevel--
            // }
            if (Array.isArray(obj)) {
              let errorFound = false
              for (let a = 0; a < obj.length; a++) {
                if (this.createResultFromObject(obj[a], constraint, focusNode)) {
                  errorFound = true
                }
              }
              return errorFound
            } else {
              if (this.createResultFromObject(obj, constraint, focusNode)) {
                return true
              }
            }
          }
        } else {
          throw new Error('Cannot find validator for constraint component ' + constraint.component.node.value)
        }
      }
      return false
    }
  }

  maxErrorsReached () {
    if (this.maxErrors) {
      return this.violationsCount >= this.maxErrors
    } else {
      return false
    }
  }

  withSubstitutions (msg, constraint) {
    let str = msg.value
    const values = constraint.parameterValues
    for (const key in values) {
      const label = nodeLabel(values[key])
      str = str.replace('{$' + key + '}', label)
      str = str.replace('{?' + key + '}', label)
    }
    return this.factory.literal(str, msg.language | msg.datatype)
  }

  getReport () {
    if (this.validationError) {
      error('Validation Failure: ' + this.validationError)
      throw (this.validationError)
    } else {
      return new ValidationReport(this.results, { factory: this.factory })
    }
  }
}

function nodeLabel (node) {
  if (node.termType === 'NamedNode') {
    // TODO: shrink URI if possible
    return '<' + node.value + '>'
  } else if (node.termType === 'BlankNode') {
    return 'Blank node ' + node.value
  } else {
    return '' + node.value
  }
}

module.exports = ValidationEngine
