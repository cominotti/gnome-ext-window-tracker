#!/bin/bash
#
# Window Size Tracker Extension - Install/Update Script
#
# This script installs or updates the Window Size Tracker GNOME Shell extension.
# It handles both fresh installations and updates to existing installations.
#
# Usage:
#   ./install.sh          # Install/update and enable the extension
#   ./install.sh --remove # Remove the extension completely
#

set -euo pipefail

# Extension configuration
EXTENSION_UUID="window-size-tracker@gnome-extension"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/${EXTENSION_UUID}"
EXTENSIONS_DIR="${HOME}/.local/share/gnome-shell/extensions"
INSTALL_DIR="${EXTENSIONS_DIR}/${EXTENSION_UUID}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored message
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running on GNOME
check_gnome() {
    if [[ -z "${XDG_CURRENT_DESKTOP:-}" ]] || [[ ! "${XDG_CURRENT_DESKTOP}" =~ GNOME ]]; then
        print_warning "This doesn't appear to be a GNOME session."
        print_warning "XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-<not set>}"
        read -p "Continue anyway? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# Check if running on Wayland
check_wayland() {
    if [[ "${XDG_SESSION_TYPE:-}" != "wayland" ]]; then
        print_warning "This extension is designed for Wayland only."
        print_warning "Current session type: ${XDG_SESSION_TYPE:-<not set>}"
        read -p "Continue anyway? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# Check if source files exist
check_source() {
    if [[ ! -d "${SOURCE_DIR}" ]]; then
        print_error "Source directory not found: ${SOURCE_DIR}"
        exit 1
    fi
    
    if [[ ! -f "${SOURCE_DIR}/extension.js" ]]; then
        print_error "extension.js not found in source directory"
        exit 1
    fi
    
    if [[ ! -f "${SOURCE_DIR}/metadata.json" ]]; then
        print_error "metadata.json not found in source directory"
        exit 1
    fi
}

# Check if extension is currently enabled
is_extension_enabled() {
    if command -v gnome-extensions &> /dev/null; then
        gnome-extensions list --enabled 2>/dev/null | grep -q "^${EXTENSION_UUID}$"
        return $?
    fi
    return 1
}

# Disable the extension
disable_extension() {
    if is_extension_enabled; then
        print_info "Disabling extension..."
        gnome-extensions disable "${EXTENSION_UUID}" 2>/dev/null || true
        sleep 1
    fi
}

# Enable the extension
enable_extension() {
    if command -v gnome-extensions &> /dev/null; then
        print_info "Enabling extension..."
        gnome-extensions enable "${EXTENSION_UUID}" 2>/dev/null || {
            print_warning "Could not enable extension automatically."
            print_warning "You may need to log out and log back in, then enable it manually."
        }
    else
        print_warning "gnome-extensions command not found."
        print_warning "Please enable the extension manually after logging out and back in."
    fi
}

# Install or update the extension
install_extension() {
    local is_update=false
    
    if [[ -d "${INSTALL_DIR}" ]]; then
        is_update=true
        print_info "Existing installation found. Updating..."
        
        # Disable before updating
        disable_extension
        
        # Backup existing installation
        local backup_dir="${INSTALL_DIR}.backup.$(date +%Y%m%d%H%M%S)"
        print_info "Creating backup at ${backup_dir}"
        mv "${INSTALL_DIR}" "${backup_dir}"
    else
        print_info "Fresh installation..."
    fi
    
    # Create extensions directory if it doesn't exist
    mkdir -p "${EXTENSIONS_DIR}"
    
    # Copy extension files
    print_info "Copying extension files to ${INSTALL_DIR}"
    cp -r "${SOURCE_DIR}" "${INSTALL_DIR}"
    
    # Set permissions
    chmod 755 "${INSTALL_DIR}"
    chmod 644 "${INSTALL_DIR}"/*
    
    if $is_update; then
        print_success "Extension updated successfully!"
    else
        print_success "Extension installed successfully!"
    fi
    
    # Enable the extension
    enable_extension
    
    echo
    print_info "Installation complete!"
    print_info "Extension location: ${INSTALL_DIR}"
    print_info "Data will be stored at: ~/.local/share/gnome-shell-extensions/${EXTENSION_UUID}/"
    echo
    print_warning "IMPORTANT: You may need to log out and log back in for changes to take effect."
    print_warning "Alternatively, you can restart GNOME Shell by pressing Alt+F2, typing 'r', and pressing Enter."
    print_warning "(Note: The 'r' restart only works on X11, not Wayland. On Wayland, you must re-login.)"
}

# Remove the extension
remove_extension() {
    print_info "Removing extension..."
    
    # Disable first
    disable_extension
    
    if [[ -d "${INSTALL_DIR}" ]]; then
        rm -rf "${INSTALL_DIR}"
        print_success "Extension removed from ${INSTALL_DIR}"
    else
        print_warning "Extension was not installed at ${INSTALL_DIR}"
    fi
    
    # Ask about removing data
    local data_dir="${HOME}/.local/share/gnome-shell-extensions/${EXTENSION_UUID}"
    if [[ -d "${data_dir}" ]]; then
        echo
        read -p "Remove saved window size data at ${data_dir}? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "${data_dir}"
            print_success "Data directory removed."
        else
            print_info "Data directory preserved at ${data_dir}"
        fi
    fi
    
    # Remove any backups
    local backups=("${EXTENSIONS_DIR}/${EXTENSION_UUID}.backup."*)
    if [[ -d "${backups[0]:-}" ]]; then
        echo
        read -p "Remove backup directories? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "${EXTENSIONS_DIR}/${EXTENSION_UUID}.backup."*
            print_success "Backup directories removed."
        fi
    fi
    
    print_success "Extension removal complete!"
}

# Show usage
show_usage() {
    echo "Window Size Tracker Extension - Install/Update Script"
    echo
    echo "Usage:"
    echo "  $0              Install or update the extension"
    echo "  $0 --remove     Remove the extension"
    echo "  $0 --help       Show this help message"
    echo
    echo "The extension will be installed to:"
    echo "  ${INSTALL_DIR}"
    echo
}

# Main
main() {
    echo "=========================================="
    echo " Window Size Tracker Extension Installer"
    echo "=========================================="
    echo
    
    case "${1:-}" in
        --remove|-r)
            remove_extension
            ;;
        --help|-h)
            show_usage
            ;;
        "")
            check_gnome
            check_wayland
            check_source
            install_extension
            ;;
        *)
            print_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
}

main "$@"
