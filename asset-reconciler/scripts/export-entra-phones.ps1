<#
    Export the staff who have a phone number recorded, for the Mobiles tab.

    Matching a handset to whoever holds it needs one thing from Entra: the
    number. Everything else in here is so the Freshservice record can say
    something useful about the person once the number has placed them.

    Only the users who have a number are written out. Two reasons: the rest
    cannot be matched by number anyway, and this file is staff personal data
    for a care provider, so the fewer people in it the better.

    Requires the Microsoft Graph PowerShell SDK:
        Install-Module Microsoft.Graph -Scope CurrentUser
#>

[CmdletBinding()]
param(
    [string] $Path = ".\entra-users-with-phone.csv",

    # Leavers are worth keeping: a disabled account still holding a handset is
    # exactly what the Mobiles tab flags. Pass -EnabledOnly to drop them.
    [switch] $EnabledOnly,

    # One Graph call per user, so it is the slow part. Skip it if you only
    # want the owner and not their line manager.
    [switch] $NoManager
)

$ErrorActionPreference = 'Stop'

Connect-MgGraph -Scopes 'User.Read.All' | Out-Null

$props = @(
    'id','displayName','userPrincipalName','mail','mobilePhone','businessPhones',
    'jobTitle','department','officeLocation','city','companyName',
    'accountEnabled','employeeId','onPremisesSamAccountName'
)

# mobilePhone is not a filterable property in Graph, so the phone test is
# applied here rather than server side. accountEnabled *is* filterable, so
# narrow on that first when it has been asked for.
$filter = if ($EnabledOnly) { 'accountEnabled eq true' } else { $null }

Write-Host "Reading users from Entra..."
$all = if ($filter) {
    Get-MgUser -All -Filter $filter -Property $props
} else {
    Get-MgUser -All -Property $props
}
Write-Host ("  {0} users read" -f $all.Count)

$withPhone = $all | Where-Object {
    $_.MobilePhone -or ($_.BusinessPhones | Where-Object { $_ -match '\d' })
}
Write-Host ("  {0} have a phone number recorded" -f $withPhone.Count)

$i = 0
$rows = foreach ($u in $withPhone) {
    $i++
    if ($i % 50 -eq 0) { Write-Host ("  ...{0}" -f $i) }

    $managerName = $null
    $managerMail = $null
    if (-not $NoManager) {
        try {
            $mgr = Get-MgUserManager -UserId $u.Id -ErrorAction Stop
            # Get-MgUserManager returns a bare directory object: displayName
            # and userPrincipalName live under AdditionalProperties, not as
            # properties of their own. Reading them directly returns blanks
            # with no error, which is how this quietly produces no managers.
            $managerName = $mgr.AdditionalProperties['displayName']
            $managerMail = $mgr.AdditionalProperties['userPrincipalName']
        } catch {
            # No manager set, or no permission to read it. Not fatal.
        }
    }

    [pscustomobject] @{
        DisplayName       = $u.DisplayName
        UserPrincipalName = $u.UserPrincipalName
        Mail              = $u.Mail
        MobilePhone       = $u.MobilePhone
        BusinessPhone     = ($u.BusinessPhones -join '; ')
        JobTitle          = $u.JobTitle
        Department        = $u.Department
        OfficeLocation    = $u.OfficeLocation
        City              = $u.City
        Company           = $u.CompanyName
        SamAccountName    = $u.OnPremisesSamAccountName
        EmployeeId        = $u.EmployeeId
        Manager           = $managerName
        ManagerEmail      = $managerMail
        AccountEnabled    = $u.AccountEnabled
    }
}

$rows | Sort-Object DisplayName |
    Export-Csv -Path $Path -NoTypeInformation -Encoding UTF8

Write-Host ""
Write-Host ("Wrote {0} rows to {1}" -f $rows.Count, (Resolve-Path $Path))
Write-Host "Load it on the 'Entra users' box. Do not open it in Excel first -"
Write-Host "it strips the leading zero off every 07xxx number."
