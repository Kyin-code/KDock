use crate::agent::store;
use tauri::AppHandle;

fn secret_name(id: &str) -> Result<String, String> {
    let id = id.trim();
    if !id.starts_with("ssh:") || id.len() > 512 || id.contains('\0') {
        return Err("SSH 凭据标识无效".into());
    }
    Ok(id.to_string())
}

#[tauri::command]
pub fn ssh_secret_set(app: AppHandle, id: String, password: String) -> Result<(), String> {
    store::secret_set(&app, &secret_name(&id)?, &password)
}

#[tauri::command]
pub fn ssh_secret_get(app: AppHandle, id: String) -> Result<Option<String>, String> {
    Ok(store::secret_get(&app, &secret_name(&id)?))
}

#[tauri::command]
pub fn ssh_secret_delete(app: AppHandle, id: String) -> Result<(), String> {
    store::secret_set(&app, &secret_name(&id)?, "")
}

#[cfg(test)]
mod tests {
    use super::secret_name;

    #[test]
    fn ssh_secret_names_require_the_ssh_namespace() {
        assert!(secret_name("ssh:user@host:22").is_ok());
        assert!(secret_name("agent-provider-key").is_err());
        assert!(secret_name("ssh:bad\0name").is_err());
    }
}
