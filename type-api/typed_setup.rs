impl Setup<'_> {
    pub(crate) fn rlint_type_handle(&self, ty: P<Type>) -> CheckerResult<Value> {
        let mut out = Obj::new();
        out.num("id", self.register_type(ty)? as f64);
        out.num("flags", ty.flags().bits() as f64);
        Ok(out.build())
    }

    pub(crate) fn rlint_symbol_handle(&self, symbol: P<Symbol>) -> CheckerResult<Value> {
        let mut reference = Obj::new();
        if let Some(file) = symbol_owner_file(symbol) {
            reference.num("kind", SYMBOL_OWNER_KIND_FILE as f64);
            reference.set("file", self.sd.host.source_file_descriptor(file)?);
            reference.num("id", tsrs_ast::get_symbol_id(symbol).0 as f64);
        } else {
            let (id, project) = self
                .sd
                .scope
                .registry
                .register_symbol(symbol, &self.sd.project)?;
            reference.num("kind", SYMBOL_OWNER_KIND_SNAPSHOT as f64);
            reference.num("snapshot", self.sd.scope.handle as f64);
            reference.str_nonempty("project", &project);
            reference.num("id", id as f64);
        }
        let mut out = Obj::new();
        out.set("reference", reference.build());
        out.num("flags", symbol.flags().bits() as f64);
        Ok(out.build())
    }

    pub(crate) fn rlint_type_property(
        &mut self,
        ty: P<Type>,
        property: &str,
    ) -> CheckerResult<Option<Value>> {
        if property == "__hydrate" {
            return self.type_response(ty).map(Some);
        }
        if property == "symbol" || property == "aliasSymbol" {
            let symbol = if property == "symbol" {
                ty.symbol()
            } else {
                ty.alias().and_then(|alias| alias.symbol())
            };
            return symbol
                .map(|symbol| self.rlint_symbol_handle(symbol))
                .transpose();
        }
        if property == "objectFlags" {
            let mut flags = ty.object_flags();
            if ty.flags().intersects(TypeFlags::Object)
                && !flags.intersects(ObjectFlags::MembersResolved)
                && self.checker.members_resolved_like_go(ty)
            {
                flags |= ObjectFlags::MembersResolved;
            }
            return Ok(Some(Value::Number(flags.bits() as f64)));
        }
        let base = type_response_base(ty, self.register_type(ty)?).build();
        if let Value::Object(fields) = &base {
            if let Some(value) = fields.get(property) {
                return Ok(Some(value.clone()));
            }
        }
        if matches!(
            property,
            "typeParameter"
                | "constraintType"
                | "nameType"
                | "templateType"
                | "labeledElementDeclarations"
        ) {
            let Value::Object(fields) = self.type_response(ty)? else {
                return Ok(None);
            };
            return Ok(fields.get(property).cloned());
        }
        Ok(None)
    }

    pub(crate) fn rlint_symbol_property(
        &self,
        symbol: P<Symbol>,
        property: &str,
    ) -> CheckerResult<Option<Value>> {
        let value = match property {
            "__hydrate" => self.symbol_response(symbol)?,
            "name" => Value::String(tsrs_ast::escape_symbol_name(symbol.name())),
            "flags" => Value::Number(symbol.flags().bits() as f64),
            "checkFlags" => Value::Number(symbol.check_flags().bits() as f64),
            "declarations" if !symbol.declarations().is_empty() => Value::Array(
                symbol
                    .declarations()
                    .iter()
                    .map(|node| self.sd.host.node_handle(*node).map(Value::String))
                    .collect::<CheckerResult<_>>()?,
            ),
            "valueDeclaration" => match symbol.value_declaration() {
                Some(node) => Value::String(self.sd.host.node_handle(node)?),
                None => return Ok(None),
            },
            "parent" => match symbol.parent() {
                Some(parent) => self.rlint_symbol_handle(parent)?,
                None => return Ok(None),
            },
            "exportSymbol" => match symbol.export_symbol() {
                Some(export) => self.rlint_symbol_handle(export)?,
                None => return Ok(None),
            },
            "reference" => {
                let Value::Object(fields) = self.rlint_symbol_handle(symbol)? else {
                    return Ok(None);
                };
                return Ok(fields.get("reference").cloned());
            }
            _ => return Ok(None),
        };
        Ok(Some(value))
    }
}
